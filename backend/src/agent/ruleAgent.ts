/**
 * Rule-based agent. Runs when no LLM is configured, when the LLM is disabled in Settings, or when an LLM call
 * fails/times out — so the chat always answers. It uses exactly the same tools (same verification, same policy,
 * same confirmation gate) as the LLM agent; only the language understanding and wording are deterministic.
 */
import { CITY_PINCODES, extractCity, extractEntities, type Entities, type Intent } from './nlu.js';
import { runTool, type TurnCtx } from './tools.js';
import { t, type Reply } from './templates.js';
import { getOrder } from '../services/orders.js';
import { updateConversation, getConversation } from '../services/conversations.js';
import { PRE_DISPATCH, evaluateAddressChange } from '../policy/policy.js';
import { productBySku } from '../policy/catalog.js';

const ORDER_INTENTS: Intent[] = ['order_status', 'cancel_order', 'return', 'exchange', 'address_change', 'refund_status'];

export interface RuleResult { reply: Reply; understood: boolean }

const ok = (text: string, ctx: TurnCtx): RuleResult => ({ reply: { text, buttons: ctx.buttons }, understood: true });
const toolDown = (ctx: TurnCtx): RuleResult => ({ reply: { text: t(ctx.lang, 'tool_down'), buttons: [{ id: 'callback', label: t(ctx.lang, 'b_callback') }] }, understood: true });

function pickOrderId(ctx: TurnCtx, ents: Entities) {
  return ents.orderIds[0] ?? ctx.conv.context_order_id ?? ctx.conv.verified_orders[ctx.conv.verified_orders.length - 1] ?? ctx.conv.candidate_order_id ?? null;
}
const isVerifiedFor = (ctx: TurnCtx, orderId: string | null) => {
  if (!orderId) return false;
  if (ctx.conv.verified_orders.includes(orderId)) return true;
  const o = getOrder(orderId);
  return !!o && !!ctx.conv.verified_phone && o.phone === ctx.conv.verified_phone;
};

export async function ruleAgent(ctx: TurnCtx, text: string, ents: Entities, intent0: Intent): Promise<RuleResult> {
  const lang = ctx.lang;
  let intent = intent0;
  let workingText = text;
  // Resume what the customer asked before we had to verify them.
  if ((intent === 'provide_details' || intent === 'unknown') && ctx.conv.pending_intent && ctx.conv.verified_orders.length) {
    intent = ctx.conv.pending_intent.intent as Intent;
    workingText = `${ctx.conv.pending_intent.text} ${text}`;
  } else if (intent === 'provide_details' && ents.orderIds.length) {
    // "what about WL10237?" — treat a bare order id as a status question
    intent = 'order_status';
  }
  const merged: Entities = intent === intent0 ? ents : { ...ents, ...mergeEnts(ents, ctx.conv.pending_intent?.text) };

  if (ORDER_INTENTS.includes(intent)) {
    const orderId = pickOrderId(ctx, merged);
    if (!isVerifiedFor(ctx, orderId)) {
      updateConversation(ctx.conv.id, { pending_intent: { intent, text: workingText } } as any);
      ctx.conv = getConversation(ctx.conv.id)!;
      if (ctx.conv.candidate_order_id && !ctx.conv.candidate_phone) return ok(t(lang, 'ask_phone', { orderId: ctx.conv.candidate_order_id }), ctx);
      if (ctx.conv.candidate_phone && !ctx.conv.candidate_order_id) return ok(t(lang, 'ask_order_id'), ctx);
      return ok(t(lang, 'ask_verify'), ctx);
    }
    updateConversation(ctx.conv.id, { pending_intent: null } as any);
    ctx.conv = getConversation(ctx.conv.id)!;
    return handleOrderIntent(ctx, intent, orderId!, workingText, merged);
  }

  switch (intent) {
    case 'greeting': return ok(t(lang, 'greeting'), ctx);
    case 'thanks': return ok(t(lang, 'thanks'), ctx);
    case 'provide_details': {
      if (ctx.conv.verified_orders.length) return ok(t(lang, 'greeting').replace(/^[^.!]*[.!]\s*/, ''), ctx);
      if (ctx.conv.candidate_order_id && !ctx.conv.candidate_phone) return ok(t(lang, 'ask_phone', { orderId: ctx.conv.candidate_order_id }), ctx);
      if (ctx.conv.candidate_phone && !ctx.conv.candidate_order_id) return ok(t(lang, 'ask_order_id'), ctx);
      return ok(t(lang, 'ask_verify'), ctx);
    }
    case 'policy_cod':
    case 'policy_shipping': {
      const pin = merged.pincodes[0] ?? (extractCity(text) ? CITY_PINCODES[extractCity(text)!] : undefined);
      if (pin) {
        const r = await runTool(ctx, 'check_pincode', { pincode: pin });
        if (!r.ok) return ok(t(lang, 'address_unclear'), ctx);
        const place = r.city ? `${r.city} (${r.pincode})` : `pincode ${r.pincode}`;
        if (intent === 'policy_cod') return ok(t(lang, 'pincode_cod', { pincode: r.pincode, place, serviceable: r.serviceable, cod: r.cod_available, days: r.delivery_days }), ctx);
        return ok(r.serviceable ? `${(await runTool(ctx, 'get_policy', { topic: 'shipping' })).policy} ${place}: ${r.delivery_days} days.` : t(lang, 'pincode_cod', { pincode: r.pincode, serviceable: false }), ctx);
      }
      const p = await runTool(ctx, 'get_policy', { topic: intent === 'policy_cod' ? 'cod' : 'shipping' });
      return ok(p.policy, ctx);
    }
    case 'policy_return':
    case 'policy_other': {
      const topic = /refund/i.test(text) ? 'refunds' : /cancel/i.test(text) ? 'cancellation' : /exchange|size/i.test(text) ? 'exchange' : 'returns';
      const p = await runTool(ctx, 'get_policy', { topic });
      return ok(p.policy, ctx);
    }
    case 'size_help': {
      const sku = merged.product ?? 'WL-KUR-01';
      const r = await runTool(ctx, 'size_recommendation', { sku, height_cm: merged.heightCm, weight_kg: merged.weightKg });
      const productName = merged.product ? productBySku(sku)!.name.toLowerCase() : (lang === 'en' ? 'our kurtas and tees' : 'kurta aur tees');
      return ok(t(lang, 'size_advice', { product: productName, recommended: r.recommended, alternatives: r.alternatives, note: sku === 'WL-TEE-02' ? 'The graphic tee is an oversized fit.' : '' }), ctx);
    }
    case 'callback': {
      await runTool(ctx, 'request_callback', { reason: `Customer asked for a callback: "${text.slice(0, 120)}"` });
      return ok(t(lang, 'callback_created'), ctx);
    }
    case 'goodwill': {
      const amt = merged.amounts[0];
      ctx.handover = { code: amt && amt > 1500 ? 'manual_review' : 'goodwill_request', reason: `Goodwill/compensation request${amt ? ` of ₹${amt}` : ''}.` };
      return ok(t(lang, 'goodwill'), ctx);
    }
    case 'bulk_order': {
      ctx.handover = { code: 'bulk_order', reason: 'Bulk / corporate order enquiry.' };
      return ok(t(lang, 'bulk'), ctx);
    }
    default:
      return { reply: { text: t(lang, 'clarify') }, understood: false };
  }
}

function mergeEnts(cur: Entities, prevText?: string) {
  if (!prevText) return {};
  // previous message entities fill gaps (e.g. product/size mentioned before verification)
  const p = extractEntities(prevText);
  return { product: cur.product ?? p.product, sizes: cur.sizes.length ? cur.sizes : p.sizes, pincodes: cur.pincodes.length ? cur.pincodes : p.pincodes, amounts: cur.amounts.length ? cur.amounts : p.amounts };
}

async function handleOrderIntent(ctx: TurnCtx, intent: Intent, orderId: string, text: string, ents: Entities): Promise<RuleResult> {
  const lang = ctx.lang;
  const order = getOrder(orderId)!;

  if (intent === 'order_status') {
    const d = await runTool(ctx, 'get_order_details', { order_id: orderId });
    if (!d.ok) return ok(t(lang, 'ask_verify'), ctx);
    let tracking: any = null;
    if (order.awb) {
      tracking = await runTool(ctx, 'track_shipment', { order_id: orderId });
      if (!tracking.ok) return toolDown(ctx);
    }
    const ov = d.order;
    return ok(t(lang, 'order_status', { order: { id: ov.order_id, items: order.items, status: ov.status, eta_from: ov.expected_delivery?.from ? `${ov.expected_delivery.from}T06:00:00Z` : null, eta_to: ov.expected_delivery?.to ? `${ov.expected_delivery.to}T06:00:00Z` : null, delivered_on: order.delivered_at }, tracking }), ctx);
  }

  if (intent === 'cancel_order') {
    const r = await runTool(ctx, 'cancel_order', { order_id: orderId, reason: text.slice(0, 150) });
    if (r.status === 'AWAITING_CUSTOMER_CONFIRMATION') return ok(r.confirmation_question, ctx);
    const d = r.decision;
    if (d?.code === 'ALREADY_SHIPPED') return ok(t(lang, 'cancel_shipped', { orderId, note: d.refundTimeline }), ctx);
    return ok(t(lang, 'cancel_other', { orderId, reason: d?.reasons?.join(' ') ?? '' }), ctx);
  }

  if (intent === 'refund_status') {
    const r = await runTool(ctx, 'get_refund_status', { order_id: orderId });
    return ok(t(lang, 'refund_status', { orderId, refunds: r.refunds ?? [], returns: r.returns ?? [] }), ctx);
  }

  if (intent === 'address_change') {
    if (!PRE_DISPATCH.includes(order.status as any)) {
      await runTool(ctx, 'get_order_details', { order_id: orderId });
      return ok(t(lang, 'address_rejected', { reason: evaluateAddressChange(order, null).reasons.join(' ') }), ctx);
    }
    if (ents.pincodes.length && text.length > 25) return proposeAddress(ctx, orderId, text, ents.pincodes[0], 'change');
    updateConversation(ctx.conv.id, { flow: { type: 'awaiting_address', orderId, purpose: 'cod' } } as any);
    ctx.conv = getConversation(ctx.conv.id)!;
    return ok(t(lang, 'address_ask'), ctx);
  }

  // return / exchange — identify the item
  const candidates = ents.product ? order.items.filter((i) => i.sku === ents.product || (ents.product === 'WL-TEE-02' && i.sku === 'WL-SAL-06')) : order.items;
  if (candidates.length !== 1) {
    updateConversation(ctx.conv.id, { pending_intent: { intent, text } } as any);
    return ok(t(lang, 'ask_item', { items: order.items.map((i) => `${i.name}${i.size && i.size !== 'ONE' ? ` (${i.size})` : ''}`).join(', ') }), ctx);
  }
  const item = candidates[0];
  const product = productBySku(item.sku)!;
  const wantsExchange = intent === 'exchange' || (ents.sizes.length > 0 && !/\brefund\b/i.test(text));

  if (wantsExchange) {
    const size = ents.sizes.find((s) => product.sizes.includes(s));
    if (!size) {
      // check eligibility first so we don't ask for a size when exchange isn't possible
      const pre = await runTool(ctx, 'check_return_options', { order_id: orderId, sku: item.sku, request_type: 'exchange' });
      const d = pre.decisions?.[0];
      if (d && !d.allowed && d.code !== 'INVALID_SIZE') return ok(t(lang, 'exchange_rejected', { reason: d.reasons.join(' ') }), ctx);
      updateConversation(ctx.conv.id, { pending_intent: { intent: 'exchange', text } } as any);
      return ok(t(lang, 'ask_size', { item: item.name, sizes: product.sizes.join(', ') }), ctx);
    }
    await runTool(ctx, 'check_stock', { sku: item.sku, size });
    const r = await runTool(ctx, 'create_exchange_request', { order_id: orderId, item_id: item.id, new_size: size, reason: text.slice(0, 150) });
    if (r.status === 'AWAITING_CUSTOMER_CONFIRMATION') return ok(r.confirmation_question, ctx);
    const reasons = r.decision?.reasons?.join(' ') ?? '';
    const alt = r.decision?.alternatives?.includes('return') ? (lang === 'en' ? ' I can raise a return for a refund instead if you like.' : ' Chahein toh refund ke liye return raise kar sakta hoon.') : '';
    return ok(t(lang, 'exchange_rejected', { reason: reasons }) + alt, ctx);
  }

  const damage = /\b(damaged|defective|torn|phata|kharab|broken|stain)\b/i.test(text);
  const r = await runTool(ctx, 'create_return_request', { order_id: orderId, item_id: item.id, reason: text.slice(0, 150), damage_claim: damage, has_photo: false });
  if (r.status === 'AWAITING_CUSTOMER_CONFIRMATION') return ok(r.confirmation_question, ctx);
  if (r.needs === 'refund_method') return ok(r.question, ctx);
  const d = r.decision;
  return ok(t(lang, 'return_rejected', { item: item.name, reason: d?.reasons?.join(' ') ?? '', exchange: d?.alternatives?.includes('size_exchange') }), ctx);
}

export async function proposeAddress(ctx: TurnCtx, orderId: string, text: string, pincode: string, purpose: 'change' | 'cod' | 'ndr'): Promise<RuleResult> {
  const lang = ctx.lang;
  const addr = text.replace(new RegExp(`\\b${pincode}\\b`), '').replace(/\b(pincode|pin|pin code)\b[:\s-]*/gi, '').replace(/\s{2,}/g, ' ').replace(/[,\s]+$/, '').trim();
  const landmark = addr.match(/\b(near|opp(?:osite)?|behind|beside)\b[^,]*/i)?.[0];
  if (purpose === 'ndr') {
    const r = await runTool(ctx, 'ndr_action', { order_id: orderId, action: 'update_address', address: addr.slice(0, 250), landmark, pincode });
    if (r.status === 'AWAITING_CUSTOMER_CONFIRMATION') return ok(r.confirmation_question, ctx);
    if (r.error === 'TOOL_UNAVAILABLE') return toolDown(ctx);
    return ok(t(lang, 'address_rejected', { reason: r.error === 'NOT_SERVICEABLE' ? `We do not deliver to pincode ${pincode}.` : r.message ?? '' }), ctx);
  }
  const r = await runTool(ctx, 'change_delivery_address', { order_id: orderId, address_line1: addr.slice(0, 250).padEnd(8, ' '), landmark, pincode });
  if (r.status === 'AWAITING_CUSTOMER_CONFIRMATION') return ok(r.confirmation_question, ctx);
  if (r.error === 'INVALID_ARGUMENTS') return ok(t(lang, 'address_unclear'), ctx);
  return ok(t(lang, 'address_rejected', { reason: r.decision?.reasons?.join(' ') ?? '' }), ctx);
}
