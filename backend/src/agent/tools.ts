/**
 * The agent's tools. Each tool has a zod input schema (also exported as JSON schema for the LLM);
 * model arguments are validated before anything runs. Rules enforced here, not in the prompt:
 *  - order data is only returned for orders the conversation is verified for (order id + matching phone),
 *  - eligibility (return / exchange / cancel / COD / address) comes from policy/policy.ts,
 *  - tools that change an order never execute directly: they store a pending action and return the exact
 *    confirmation question; the change runs only after the customer says yes (engine → actions.ts).
 * Every call is persisted to tool_calls (inputs/outputs PII-masked) for the dashboard trace.
 */
import { z } from 'zod';
import { getDb, nowIso } from '../db/index.js';
import { uid } from '../lib/ids.js';
import { maskDeep, maskText, normalizePhone } from '../lib/pii.js';
import { fmtDate, inr } from '../lib/time.js';
import { log } from '../lib/logger.js';
import { PRODUCTS, productBySku } from '../policy/catalog.js';
import { evaluateAddressChange, evaluateCancellation, evaluateCod, evaluateExchange, evaluateReturn, POLICY, prepaidQuote, daysSince } from '../policy/policy.js';
import { POLICY_DOC, recommendSize } from '../policy/policyDoc.js';
import { getSettings } from '../settings.js';
import { courier } from '../services/courierClient.js';
import { getConversation, updateConversation, type Conversation, type PendingAction } from '../services/conversations.js';
import { getOrder, getStock, ordersForPhone, pincodeInfo, returnsLast60Days, type Order, type OrderItem } from '../services/orders.js';
import { activeRequestForItem, refundView } from '../services/returns.js';
import { confirmCod, paymentLink, shortAddress } from '../services/cod.js';
import { allowedNdrDates, ndrApply, ndrDateButtons, rtoRefundIfRefused } from '../services/ndr.js';
import { createCallbackTicket, type HandoverCode } from './handover.js';
import { statusLabel, t, yesNo, type Button } from './templates.js';
import { CITY_PINCODES, extractCity, extractEntities, type Lang } from './nlu.js';

export class ToolUnavailable extends Error {}

export interface CallRecord { id: string; name: string; input: any; output: any; ok: boolean; durationMs: number }
export interface TurnCtx {
  conv: Conversation; turnId: string; lang: Lang; actor: 'agent' | 'system';
  calls: CallRecord[]; buttons?: Button[]; handover?: { code: HandoverCode; reason: string } | null;
  pendingProposed?: PendingAction | null; toolFailures: number;
}

const refresh = (ctx: TurnCtx) => { ctx.conv = getConversation(ctx.conv.id)!; };

// ----------------------------------------------------------------------------- helpers
const ORDER_ID = z.string().trim().regex(/^#?\s?(WL)?\s?-?\d{5}$/i, 'Order id looks like WL10234').transform((s) => `WL${s.replace(/\D/g, '')}`);
const PHONE = z.string().trim().transform((s) => normalizePhone(s)).refine((s) => /^[6-9]\d{9}$/.test(s), '10-digit Indian mobile number');
const PINCODE = z.string().trim().regex(/^[1-9]\d{5}$/, '6-digit pincode');

function access(ctx: TurnCtx, orderId: string): { order: Order } | { error: any } {
  const o = getOrder(orderId);
  const verifiedFor = ctx.conv.verified_orders.includes(orderId) || (!!o && !!ctx.conv.verified_phone && o.phone === ctx.conv.verified_phone);
  if (!o || !verifiedFor) {
    return { error: { ok: false, error: 'NOT_VERIFIED', message: 'The customer is not verified for this order. Ask for the order ID and the phone number used on the order, then call verify_customer. Share nothing about the order until verified.' } };
  }
  if (!ctx.conv.verified_orders.includes(o.id)) {
    updateConversation(ctx.conv.id, { verified_orders: [...ctx.conv.verified_orders, o.id] } as any);
    refresh(ctx);
  }
  if (ctx.conv.context_order_id !== o.id) { updateConversation(ctx.conv.id, { context_order_id: o.id } as any); refresh(ctx); }
  return { order: o };
}

export function orderView(o: Order) {
  return {
    order_id: o.id, status: o.status, status_label: statusLabel('en', o.status), payment_method: o.payment_method, cod_confirmation: o.cod_confirmation,
    items: o.items.map((i) => ({ item_id: i.id, sku: i.sku, name: i.name, size: i.size, qty: i.qty, price: i.price, exchanges_used: i.exchange_count })),
    subtotal: o.subtotal, shipping_fee: o.shipping_fee, cod_fee: o.cod_fee, discount: o.discount, total: o.total,
    placed_on: o.created_at.slice(0, 10), placed_on_text: fmtDate(o.created_at),
    shipped_on: o.shipped_at?.slice(0, 10) ?? null, delivered_on: o.delivered_at?.slice(0, 10) ?? null, delivered_on_text: o.delivered_at ? fmtDate(o.delivered_at) : null,
    days_since_delivery: o.delivered_at ? daysSince(o.delivered_at, Date.now()) : null,
    expected_delivery: ['delivered', 'cancelled', 'rto_initiated', 'rto_delivered'].includes(o.status) ? null : { from: o.eta_from?.slice(0, 10), to: o.eta_to?.slice(0, 10), text: `${fmtDate(o.eta_from)} – ${fmtDate(o.eta_to)}` },
    delivery_city: o.city, delivery_pincode: o.pincode, awb: o.awb, courier: o.courier,
    tracking_url: o.awb ? courier.trackingUrl(o.awb) : null,
    failed_delivery: o.ndr_attempts > 0 ? { attempts: o.ndr_attempts, last_reason: o.ndr_reason, status: o.ndr_status } : null,
    // Policy decisions computed in code, so the model never has to reason about eligibility itself.
    policy_now: (() => {
      const c = evaluateCancellation(o);
      const addr = evaluateAddressChange(o, pincodeInfo(o.pincode));
      return {
        cancellation: { allowed: c.allowed, why: c.reasons.join(' '), options_if_not: c.alternatives, money: c.refundTimeline ?? null },
        address_change: { allowed: addr.allowed || addr.code === 'COD_NOT_AVAILABLE', why: addr.allowed ? 'Order not dispatched yet — the address can be changed (new pincode is checked when given).' : addr.reasons.join(' ') },
        return_or_exchange_window: o.delivered_at ? (daysSince(o.delivered_at, Date.now()) <= POLICY.returnWindowDays ? `open (delivered ${daysSince(o.delivered_at, Date.now())} day(s) ago, 7-day window) — item rules still apply, use the return/exchange tools` : 'closed (more than 7 days since delivery)') : 'not delivered yet',
      };
    })(),
  };
}

/** Map "kurta", "the briefs", "sale tee", "WL-KUR-01" → SKU. */
function skuFrom(text?: string) {
  if (!text) return undefined;
  if (productBySku(text)) return text.toUpperCase();
  return extractEntities(text).product ?? PRODUCTS.find((p) => p.name.toLowerCase().includes(text.toLowerCase()))?.sku;
}

function resolveItem(o: Order, sku?: string, itemId?: string): { item: OrderItem } | { error: any } {
  let it = itemId ? o.items.find((i) => i.id === itemId) : undefined;
  const want = skuFrom(sku);
  if (!it && want) it = o.items.find((i) => i.sku === want) ?? (want === 'WL-TEE-02' ? o.items.find((i) => i.sku === 'WL-SAL-06') : undefined);
  if (!it && o.items.length === 1) it = o.items[0];
  if (!it) return { error: { ok: false, error: 'WHICH_ITEM', message: 'Ask the customer which item.', items: o.items.map((i) => ({ item_id: i.id, sku: i.sku, name: i.name, size: i.size })) } };
  return { item: it };
}

function propose(ctx: TurnCtx, type: string, params: Record<string, any>, question: string) {
  const pa: PendingAction = { type, params, summary: question, created_at: nowIso(), orderId: params.orderId };
  updateConversation(ctx.conv.id, { pending_action: pa } as any);
  refresh(ctx);
  ctx.pendingProposed = pa;
  ctx.buttons = yesNo(ctx.lang);
  return { ok: true, status: 'AWAITING_CUSTOMER_CONFIRMATION', confirmation_question: question, instruction: 'Ask the customer this confirmation question (in their language) and wait. Nothing has been changed yet — do not say it is done.' };
}

// ----------------------------------------------------------------------------- tool definitions
interface ToolDef { name: string; description: string; schema: z.ZodType<any>; run: (ctx: TurnCtx, a: any) => Promise<any> | any }

const tools: ToolDef[] = [
  {
    name: 'verify_customer',
    description: 'Verify the customer owns an order: needs the order ID AND the phone number used on that order. Required before sharing ANY order detail.',
    schema: z.object({ order_id: ORDER_ID, phone: PHONE }),
    run: (ctx, a) => {
      const max = getSettings().handover.maxVerifyAttempts;
      if (ctx.conv.verify_attempts >= max) return { ok: false, error: 'TOO_MANY_ATTEMPTS', message: 'Verification locked after repeated failures. Hand over to a person.' };
      const o = getOrder(a.order_id);
      if (!o || o.phone !== a.phone) {
        updateConversation(ctx.conv.id, { verify_attempts: ctx.conv.verify_attempts + 1, candidate_order_id: null, candidate_phone: null } as any);
        refresh(ctx);
        return { ok: false, error: 'VERIFICATION_FAILED', message: 'Order ID and phone number do not match. Share nothing about any order; ask the customer to re-check both.', attempts_left: Math.max(0, max - ctx.conv.verify_attempts) };
      }
      updateConversation(ctx.conv.id, { verified_phone: o.phone, verified_orders: [...new Set([...ctx.conv.verified_orders, o.id])], customer_phone: o.phone, customer_name: o.name, context_order_id: o.id, verify_attempts: 0, candidate_order_id: null, candidate_phone: null } as any);
      refresh(ctx);
      return { ok: true, verified: true, order_id: o.id, customer_first_name: o.name.split(' ')[0] };
    },
  },
  {
    name: 'get_order_details',
    description: 'Get status, items, amounts, dates and expected delivery for a verified order.',
    schema: z.object({ order_id: ORDER_ID }),
    run: (ctx, a) => { const r = access(ctx, a.order_id); return 'error' in r ? r.error : { ok: true, order: orderView(r.order) }; },
  },
  {
    name: 'track_shipment',
    description: 'Live courier tracking for a verified order (current status, last scan, re-attempt date, tracking link).',
    schema: z.object({ order_id: ORDER_ID }),
    run: async (ctx, a) => {
      const r = access(ctx, a.order_id); if ('error' in r) return r.error;
      const o = r.order;
      if (!o.awb) return { ok: true, shipped: false, current_status: o.status, message: 'Not handed to the courier yet.', expected_delivery: orderView(o).expected_delivery };
      let tr;
      try { tr = await courier.track(o.awb); } catch (e: any) { throw new ToolUnavailable(`courier tracking failed: ${e.message}`); }
      const last = tr.timeline[tr.timeline.length - 1];
      return {
        ok: true, shipped: true, courier: tr.courier, awb: tr.awb, current_status: tr.status, current_status_label: statusLabel('en', tr.status),
        failed_attempts: tr.attempts, scheduled_reattempt: tr.scheduled_date, last_update: last ? { at: last.at, at_text: fmtDate(last.at), location: last.location ?? null, note: last.note ?? null } : null,
        recent_events: tr.timeline.slice(-3).map((e) => ({ status: e.status, at_text: fmtDate(e.at), location: e.location ?? null })),
        tracking_url: courier.trackingUrl(tr.awb), expected_delivery: orderView(o).expected_delivery,
      };
    },
  },
  {
    name: 'list_my_orders',
    description: "List the verified customer's own orders (only works after verification).",
    schema: z.object({}),
    run: (ctx) => {
      if (!ctx.conv.verified_phone) return { ok: false, error: 'NOT_VERIFIED', message: 'Verify the customer first.' };
      return { ok: true, orders: ordersForPhone(ctx.conv.verified_phone).map((o) => ({ order_id: o.id, status: o.status, placed_on: o.created_at.slice(0, 10), total: o.total, items: o.items.map((i) => i.name) })) };
    },
  },
  {
    name: 'get_refund_status',
    description: 'Refund and return records for a verified order, with the policy-based expected window. Never promise dates outside this.',
    schema: z.object({ order_id: ORDER_ID }),
    run: (ctx, a) => { const r = access(ctx, a.order_id); if ('error' in r) return r.error; return { ok: true, order_id: r.order.id, payment_method: r.order.payment_method, ...refundView(r.order.id) }; },
  },
  {
    name: 'check_return_options',
    description: 'Policy decision (computed in code) for returning or exchanging an item of a verified order. Use this before offering anything.',
    schema: z.object({ order_id: ORDER_ID, sku: z.string().optional().describe('SKU or product name, e.g. "kurta"'), request_type: z.enum(['return', 'exchange']), new_size: z.string().optional(), damage_claim: z.boolean().optional(), has_photo: z.boolean().optional() }),
    run: (ctx, a) => {
      const r = access(ctx, a.order_id); if ('error' in r) return r.error;
      const o = r.order;
      const want = skuFrom(a.sku);
      const targets = want ? o.items.filter((i) => i.sku === want || (want === 'WL-TEE-02' && i.sku === 'WL-SAL-06')) : o.items;
      if (!targets.length) return { ok: false, error: 'ITEM_NOT_IN_ORDER', items: o.items.map((i) => i.sku) };
      const ret60 = returnsLast60Days(o.phone);
      return {
        ok: true, order_id: o.id, delivered_on: o.delivered_at?.slice(0, 10) ?? null,
        decisions: targets.map((item) => {
          const product = productBySku(item.sku)!;
          const d = a.request_type === 'exchange'
            ? evaluateExchange({ order: o, item, product, newSize: a.new_size ?? '', stockQty: a.new_size ? getStock(item.sku, a.new_size) : 1, returnsLast60Days: ret60, hasActiveRequest: activeRequestForItem(item.id) })
            : evaluateReturn({ order: o, item, product, returnsLast60Days: ret60, hasActiveRequest: activeRequestForItem(item.id), isDamageClaim: a.damage_claim, hasPhoto: a.has_photo, refundLimit: getSettings().handover.refundLimit });
          const next = d.allowed
            ? `Eligible. If the customer asked for this, call ${a.request_type === 'exchange' ? 'create_exchange_request' : 'create_return_request'} NOW (it shows the confirmation question itself) — do not ask the customer whether to proceed first.`
            : 'Not eligible — explain the reasons and offer the alternatives listed, if any.';
          return { item_id: item.id, sku: item.sku, name: item.name, size: item.size, ...d, next_step: next, ...(a.request_type === 'exchange' && !a.new_size && d.code !== 'INVALID_SIZE' ? { note: 'new_size not given — ask which size; stock not checked yet', sizes: product.sizes } : {}) };
        }),
      };
    },
  },
  {
    name: 'check_stock',
    description: 'Check if a product size is in stock.',
    schema: z.object({ sku: z.string(), size: z.string() }),
    run: (_ctx, a) => {
      const p = productBySku(a.sku);
      if (!p) return { ok: false, error: 'UNKNOWN_SKU', skus: PRODUCTS.map((x) => x.sku) };
      const size = a.size.toUpperCase();
      if (!p.sizes.includes(size)) return { ok: true, sku: p.sku, size, exists: false, sizes: p.sizes };
      const q = getStock(p.sku, size);
      return { ok: true, sku: p.sku, name: p.name, size, in_stock: q > 0, availability: q === 0 ? 'out of stock' : q <= 3 ? 'only a few left' : 'in stock' };
    },
  },
  {
    name: 'create_exchange_request',
    description: 'Prepare a size exchange for an item in a verified order. Checks policy + stock and returns a confirmation question. Executes only after the customer says yes.',
    schema: z.object({ order_id: ORDER_ID, sku: z.string().optional().describe('SKU or product name, e.g. "kurta"'), item_id: z.string().optional(), new_size: z.string().min(1), reason: z.string().max(200).optional() }),
    run: (ctx, a) => {
      const r = access(ctx, a.order_id); if ('error' in r) return r.error;
      const ri = resolveItem(r.order, a.sku, a.item_id); if ('error' in ri) return ri.error;
      const item = ri.item; const product = productBySku(item.sku)!;
      const newSize = String(a.new_size).toUpperCase();
      const d = evaluateExchange({ order: r.order, item, product, newSize, stockQty: getStock(item.sku, newSize), returnsLast60Days: returnsLast60Days(r.order.phone), hasActiveRequest: activeRequestForItem(item.id) });
      if (!d.allowed) return { ok: true, eligible: false, decision: d };
      return { ...propose(ctx, 'create_exchange', { orderId: r.order.id, itemId: item.id, newSize, reason: a.reason && maskText(a.reason) }, t(ctx.lang, 'exchange_q', { item: item.name, from: item.size, to: newSize, orderId: r.order.id })), eligible: true, decision: d };
    },
  },
  {
    name: 'create_return_request',
    description: 'Prepare a return (refund) for an item of a verified order. Policy decides eligibility. COD orders need refund_method (bank_transfer or store_credit). Executes only after the customer says yes.',
    schema: z.object({ order_id: ORDER_ID, sku: z.string().optional().describe('SKU or product name, e.g. "briefs"'), item_id: z.string().optional(), reason: z.string().max(200).optional(), refund_method: z.enum(['bank_transfer', 'store_credit', 'original_payment_method']).optional(), damage_claim: z.boolean().optional(), has_photo: z.boolean().optional() }),
    run: (ctx, a) => {
      const r = access(ctx, a.order_id); if ('error' in r) return r.error;
      const ri = resolveItem(r.order, a.sku, a.item_id); if ('error' in ri) return ri.error;
      const item = ri.item; const product = productBySku(item.sku)!;
      const d = evaluateReturn({ order: r.order, item, product, returnsLast60Days: returnsLast60Days(r.order.phone), hasActiveRequest: activeRequestForItem(item.id), isDamageClaim: a.damage_claim, hasPhoto: a.has_photo, refundLimit: getSettings().handover.refundLimit });
      if (!d.allowed) return { ok: true, eligible: false, decision: d };
      let method = a.refund_method;
      // For COD the customer must choose — ignore a method the model picked unless the customer actually said it.
      if (r.order.payment_method === 'cod' && method) {
        const said = getDb().prepare(`SELECT content FROM messages WHERE conversation_id=? AND role='customer' ORDER BY created_at DESC LIMIT 6`).all(ctx.conv.id).map((m: any) => m.content).join(' ').toLowerCase();
        const chose = method === 'bank_transfer' ? /bank|transfer|account|neft|imps|upi/.test(said) : method === 'store_credit' ? /store|credit|wallet|voucher/.test(said) : false;
        if (!chose) method = undefined;
      }
      if (r.order.payment_method === 'prepaid') method = 'original_payment_method';
      else if (!method || method === 'original_payment_method') {
        ctx.buttons = [{ id: 'refund_method:bank_transfer', label: t(ctx.lang, 'b_bank') }, { id: 'refund_method:store_credit', label: t(ctx.lang, 'b_credit') }];
        updateConversation(ctx.conv.id, { flow: { type: 'awaiting_refund_method', orderId: r.order.id, data: { itemId: item.id, reason: a.reason, damageClaim: a.damage_claim, hasPhoto: a.has_photo } } } as any);
        refresh(ctx);
        return { ok: true, eligible: true, needs: 'refund_method', question: t(ctx.lang, 'ask_refund_method'), decision: d };
      }
      const methodText = method === 'original_payment_method' ? 'to your original payment method' : method === 'bank_transfer' ? 'by bank transfer' : 'as store credit';
      const q = d.outcome === 'manual_review'
        ? t(ctx.lang, 'return_review_q', { item: item.name, amount: d.refundAmount })
        : t(ctx.lang, 'return_q', { item: item.name, orderId: r.order.id, amount: d.refundAmount, methodText });
      return { ...propose(ctx, 'create_return', { orderId: r.order.id, itemId: item.id, reason: a.reason && maskText(a.reason), refundMethod: method, damageClaim: a.damage_claim, hasPhoto: a.has_photo }, q), eligible: true, decision: d };
    },
  },
  {
    name: 'cancel_order',
    description: 'Request cancellation of a verified order. Policy: free before shipping; after shipping returns the alternatives (refuse delivery / return). Executes only after the customer says yes.',
    schema: z.object({ order_id: ORDER_ID, reason: z.string().max(200).optional() }),
    run: (ctx, a) => {
      const r = access(ctx, a.order_id); if ('error' in r) return r.error;
      const d = evaluateCancellation(r.order);
      if (!d.allowed) return { ok: true, cancellable: false, decision: d };
      return { ...propose(ctx, 'cancel_order', { orderId: r.order.id, reason: maskText(a.reason ?? 'customer request') }, t(ctx.lang, 'cancel_q', { order: r.order, refundNote: d.refundTimeline })), cancellable: true, decision: d };
    },
  },
  {
    name: 'change_delivery_address',
    description: 'Change the delivery address of a verified order (only before dispatch; pincode must be serviceable, and COD-enabled for COD orders). Call it as soon as the customer asks — even before you have the new address — to learn whether a change is possible. Executes only after the customer says yes.',
    schema: z.object({ order_id: ORDER_ID, address_line1: z.string().min(8).max(250).optional(), landmark: z.string().max(120).optional(), city: z.string().max(60).optional(), pincode: PINCODE.optional() }),
    run: (ctx, a) => {
      const r = access(ctx, a.order_id); if ('error' in r) return r.error;
      if (!a.address_line1 || !a.pincode) {
        const pre = evaluateAddressChange(r.order, pincodeInfo(r.order.pincode));
        if (!pre.allowed && pre.code !== 'COD_NOT_AVAILABLE') return { ok: true, allowed: false, decision: pre };
        return { ok: true, allowed: 'pending_new_address', needs: ['address_line1', 'pincode'], message: 'A change is possible (not dispatched yet). Ask for the full new address with house/flat number and the 6-digit pincode.' };
      }
      const d = evaluateAddressChange(r.order, pincodeInfo(a.pincode));
      if (!d.allowed) return { ok: true, allowed: false, decision: d };
      const full = [a.address_line1, a.landmark, a.city].filter(Boolean).join(', ');
      return { ...propose(ctx, 'change_address', { orderId: r.order.id, address_line1: a.address_line1, landmark: a.landmark, city: a.city, pincode: a.pincode }, t(ctx.lang, 'address_q', { orderId: r.order.id, address: full, pincode: a.pincode })), allowed: true, decision: d };
    },
  },
  {
    name: 'check_pincode',
    description: 'Serviceability, COD availability and delivery time for a pincode or a city name (policy-based).',
    schema: z.object({ pincode: PINCODE.optional(), city: z.string().max(60).optional(), order_value: z.number().optional() }),
    run: (_ctx, a) => {
      const city = a.city ? extractCity(a.city) : undefined;
      const pin = a.pincode ?? (city ? CITY_PINCODES[city] : undefined);
      if (!pin) return { ok: false, error: 'UNKNOWN_CITY', message: 'City not in our list — ask the customer for the 6-digit pincode.' };
      const p = pincodeInfo(pin);
      if (!p) return { ok: false, error: 'INVALID_PINCODE' };
      const days = POLICY.eta[p.zone];
      const cod = evaluateCod(a.order_value ?? 1000, p);
      return { ok: true, pincode: p.pincode, city: p.city, state: p.state, serviceable: p.serviceable, cod_available: p.serviceable && p.cod, cod_check: a.order_value ? cod : undefined, zone: p.zone, delivery_days: `${days[0]}-${days[1]}`, cod_fee: POLICY.cod.fee, cod_order_range: [POLICY.cod.min, POLICY.cod.max], prepaid_discount_pct: POLICY.cod.prepaidDiscountPct };
    },
  },
  {
    name: 'get_policy',
    description: 'The written store policy text for a topic. Answer policy questions only from this.',
    schema: z.object({ topic: z.enum(['returns', 'exchange', 'cancellation', 'refunds', 'cod', 'shipping', 'manual_review']) }),
    run: (_ctx, a) => ({ ok: true, topic: a.topic, policy: POLICY_DOC[a.topic] }),
  },
  {
    name: 'search_catalog',
    description: 'Search products (name, price, sizes, return rules, description). Answer product questions only from this.',
    schema: z.object({ query: z.string().max(80).optional() }),
    run: (_ctx, a) => {
      const q = (a.query ?? '').toLowerCase();
      const hits = PRODUCTS.filter((p) => !q || `${p.name} ${p.sku} ${p.category} ${p.description}`.toLowerCase().includes(q) || q.includes(p.category));
      return { ok: true, products: (hits.length ? hits : PRODUCTS).map((p) => ({ sku: p.sku, name: p.name, price: p.price, sizes: p.sizes, in_stock_sizes: p.sizes.filter((s) => getStock(p.sku, s) > 0), returns: p.notes, description: p.description })) };
    },
  },
  {
    name: 'size_recommendation',
    description: 'Recommend a size from the size chart given height (cm) and/or weight (kg). 5\'8" = 173 cm.',
    schema: z.object({ sku: z.string().optional().describe('SKU or product name; omit for kurtas/tees'), height_cm: z.number().min(120).max(220).optional(), weight_kg: z.number().min(30).max(200).optional() }),
    run: (_ctx, a) => {
      const p = productBySku(skuFrom(a.sku) ?? 'WL-KUR-01');
      if (!p) return { ok: false, error: 'UNKNOWN_SKU', skus: PRODUCTS.map((x) => x.sku) };
      const r = recommendSize(p.sku, a.height_cm, a.weight_kg);
      return { ok: true, product: p.name, ...r, recommended_in_stock: r.recommended ? getStock(p.sku, r.recommended) > 0 : null };
    },
  },
  {
    name: 'cod_order_action',
    description: 'Customer response to a COD confirmation request: confirm, cancel (needs yes), switch_to_prepaid (sends 5%-off payment link) or edit_address (asks for new address).',
    schema: z.object({ order_id: ORDER_ID, action: z.enum(['confirm', 'cancel', 'switch_to_prepaid', 'edit_address']) }),
    run: (ctx, a) => {
      const r = access(ctx, a.order_id); if ('error' in r) return r.error;
      const o = r.order;
      if (o.payment_method !== 'cod' || !['pending', 'on_hold'].includes(o.cod_confirmation)) return { ok: false, error: 'NOT_PENDING_CONFIRMATION', status: o.status, cod_confirmation: o.cod_confirmation };
      if (a.action === 'confirm') { const u = confirmCod(o.id, 'customer', ctx.conv.id); return { ok: true, done: 'confirmed', order_id: u.id, amount_to_pay: u.total, message: t(ctx.lang, 'cod_confirmed', { orderId: u.id, total: u.total }) }; }
      if (a.action === 'cancel') return propose(ctx, 'cod_cancel', { orderId: o.id, reason: 'cancelled at COD confirmation' }, t(ctx.lang, 'cod_cancel_q', { orderId: o.id, total: o.total }));
      if (a.action === 'switch_to_prepaid') { const q = prepaidQuote(o); return { ok: true, payment_link: paymentLink(o.id), payable: q.payable, discount: q.discount, message: t(ctx.lang, 'cod_prepaid', { payable: q.payable, link: paymentLink(o.id) }) }; }
      updateConversation(ctx.conv.id, { flow: { type: 'awaiting_address', orderId: o.id, purpose: 'cod' } } as any); refresh(ctx);
      return { ok: true, awaiting: 'new_address', current_address: shortAddress(o), message: t(ctx.lang, 'cod_address_ask') };
    },
  },
  {
    name: 'ndr_action',
    description: 'Act on a failed delivery for a verified order: reschedule (date within next 3 days, YYYY-MM-DD), update_address (address + pincode, needs yes), alternate_phone, or cancel_order (customer no longer wants it; needs reason + yes).',
    schema: z.object({ order_id: ORDER_ID, action: z.enum(['reschedule', 'update_address', 'alternate_phone', 'cancel_order']), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), address: z.string().min(5).max(250).optional(), landmark: z.string().max(120).optional(), pincode: PINCODE.optional(), phone: PHONE.optional(), reason: z.string().max(200).optional() }),
    run: async (ctx, a) => {
      const r = access(ctx, a.order_id); if ('error' in r) return r.error;
      const o = r.order;
      if (o.status !== 'delivery_failed' && o.ndr_status !== 'open') return { ok: false, error: 'NO_FAILED_DELIVERY', status: o.status };
      try {
        if (a.action === 'reschedule') {
          const allowed = allowedNdrDates();
          if (!a.date || !allowed.includes(a.date)) { ctx.buttons = ndrDateButtons(o.id); return { ok: false, error: 'DATE_NOT_ALLOWED', allowed_dates: allowed, message: 'Re-attempt must be within the next 3 days.' }; }
          await ndrApply(o.id, 'reschedule', { date: a.date }, 'agent', ctx.conv.id);
          return { ok: true, done: 'rescheduled', date: a.date, date_text: fmtDate(`${a.date}T06:00:00Z`) };
        }
        if (a.action === 'alternate_phone') {
          if (!a.phone) return { ok: false, error: 'PHONE_REQUIRED' };
          await ndrApply(o.id, 'update_phone', { phone: a.phone }, 'agent', ctx.conv.id);
          return { ok: true, done: 'alternate_phone_added' };
        }
        if (a.action === 'update_address') {
          if (!a.address) return { ok: false, error: 'ADDRESS_REQUIRED' };
          const pin = a.pincode ?? o.pincode!;
          const pi = pincodeInfo(pin);
          if (!pi?.serviceable) return { ok: false, error: 'NOT_SERVICEABLE', pincode: pin };
          return propose(ctx, 'ndr_address', { orderId: o.id, address: a.address, landmark: a.landmark, pincode: pin }, t(ctx.lang, 'address_q', { orderId: o.id, address: [a.address, a.landmark].filter(Boolean).join(', '), pincode: pin }));
        }
        if (!a.reason) { updateConversation(ctx.conv.id, { flow: { type: 'awaiting_rto_reason', orderId: o.id } } as any); refresh(ctx); return { ok: true, needs: 'reason', question: t(ctx.lang, 'ndr_rto_reason') }; }
        return propose(ctx, 'ndr_rto', { orderId: o.id, reason: a.reason }, t(ctx.lang, 'ndr_rto_q', { orderId: o.id, prepaid: o.payment_method === 'prepaid', refund: rtoRefundIfRefused(o.total) }));
      } catch (e: any) {
        throw new ToolUnavailable(`courier NDR update failed: ${e.message}`);
      }
    },
  },
  {
    name: 'request_callback',
    description: 'Create a callback request for the support team (e.g. when live data could not be fetched). The AI keeps handling the chat.',
    schema: z.object({ reason: z.string().max(300) }),
    run: (ctx, a) => ({ ok: true, ticket_id: createCallbackTicket(ctx.conv.id, a.reason, ctx.conv.context_order_id) }),
  },
  {
    name: 'handover_to_human',
    description: 'Hand the chat to a human. Use when: customer asks for a person; is upset; mentions legal action/consumer court/social media; refund or goodwill > ₹1,500 or policy says manual review; you are not sure what they want; or you failed to solve the same issue twice.',
    schema: z.object({ reason_code: z.enum(['customer_request', 'angry_customer', 'legal_threat', 'manual_review', 'goodwill_request', 'unclear_request', 'repeated_failure', 'bulk_order', 'other']), reason: z.string().max(300) }),
    run: (ctx, a) => { ctx.handover = { code: a.reason_code, reason: a.reason }; return { ok: true, handed_over: true, instruction: 'Tell the customer a teammate will join shortly. Do not promise outcomes.' }; },
  },
];

export const TOOL_NAMES = tools.map((t) => t.name);
const byName = new Map(tools.map((t) => [t.name, t]));

/** JSON-schema tool specs for the LLM. */
export function toolSpecs() {
  return tools.map((t) => {
    const js: any = z.toJSONSchema(t.schema, { io: 'input', unrepresentable: 'any' });
    delete js.$schema;
    return { name: t.name, description: t.description, parameters: js };
  });
}

/** Validate → run → record. Never throws: failures come back as structured errors the agent can relay. */
export async function runTool(ctx: TurnCtx, name: string, rawArgs: unknown, actor: 'agent' | 'system' = 'agent'): Promise<any> {
  const started = Date.now();
  const def = byName.get(name);
  let output: any;
  let ok = true;
  let error: string | null = null;
  let args: any = rawArgs;
  if (!def) {
    output = { ok: false, error: 'UNKNOWN_TOOL', message: `No tool named ${name}` }; ok = false; error = 'unknown tool';
  } else {
    const parsed = def.schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      output = { ok: false, error: 'INVALID_ARGUMENTS', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
      ok = false; error = 'invalid arguments';
    } else {
      args = parsed.data;
      try {
        output = await def.run(ctx, args);
        if (output?.ok === false) { ok = false; error = output.error ?? 'failed'; }
      } catch (e: any) {
        ok = false;
        if (e instanceof ToolUnavailable) {
          ctx.toolFailures++;
          updateConversation(ctx.conv.id, { tool_failures: ctx.conv.tool_failures + 1 } as any); refresh(ctx);
          output = { ok: false, error: 'TOOL_UNAVAILABLE', message: "Live data couldn't be fetched. Tell the customer you couldn't fetch the live details right now and ASK whether they'd like a callback. Call request_callback only after they say yes. Do not guess." };
        } else {
          output = { ok: false, error: 'INTERNAL_ERROR', message: 'Something went wrong running this tool.' };
        }
        error = String(e?.message ?? e);
        log.error('tool failed', { tool: name, error });
      }
    }
  }
  const durationMs = Date.now() - started;
  const id = uid('tc_');
  getDb().prepare(`INSERT INTO tool_calls(id,conversation_id,turn_id,name,input,output,ok,error,duration_ms,actor,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, ctx.conv.id, ctx.turnId, name, JSON.stringify(maskDeep(args ?? {})), JSON.stringify(maskDeep(output)), ok ? 1 : 0, error, durationMs, actor, nowIso());
  ctx.calls.push({ id, name, input: args, output, ok, durationMs });
  return output;
}

export { inr };
