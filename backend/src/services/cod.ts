/**
 * COD confirmation flow:
 *   order webhook → risk score → confirmation message (<1 min) with Confirm / Cancel / Edit address / Pay online (5% off)
 *   → no reply after `codReminderSec` → one reminder → still nothing after `codHoldSec` → order on hold (dashboard).
 * All timings come from Settings. Every message has a dedupe key, so duplicate webhooks/jobs never double-send.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { getDb, nowIso } from '../db/index.js';
import { log } from '../lib/logger.js';
import { getQueue } from '../queue/index.js';
import { getSettings } from '../settings.js';
import { prepaidQuote, PRE_DISPATCH } from '../policy/policy.js';
import { t, type Button, type Reply } from '../agent/templates.js';
import type { Lang } from '../agent/nlu.js';
import { courier } from './courierClient.js';
import { findOrCreateForPhone, getConversation, getMessages, updateConversation } from './conversations.js';
import { sendToCustomer } from './messaging.js';
import { addOrderNote, computeRisk, getOrder, updateOrder, adjustStock, type Order } from './orders.js';

export const codButtons = (lang: Lang, orderId: string): Button[] => [
  { id: `cod:confirm:${orderId}`, label: t(lang, 'b_confirm') },
  { id: `cod:cancel:${orderId}`, label: t(lang, 'b_cancel') },
  { id: `cod:edit_address:${orderId}`, label: t(lang, 'b_edit') },
  { id: `cod:prepaid:${orderId}`, label: t(lang, 'b_prepaid') },
];

export const shortAddress = (o: Order) => [o.address_line1, o.address_line2, o.landmark, o.city, o.pincode].filter(Boolean).join(', ');

/** Called once per new order (idempotent: jobs are keyed by order id). */
export async function onOrderCreated(order: Order) {
  const q = getQueue();
  if (order.payment_method !== 'cod') {
    await q.add('shipment.create', { orderId: order.id }, { key: `ship:${order.id}` });
    return;
  }
  const risk = computeRisk(order);
  const s = getSettings();
  updateOrder(order.id, { risk_score: risk.score, risk_band: risk.band, risk_reasons: risk.reasons }, 'system', 'COD risk scored');
  if (!risk.codAllowed) {
    updateOrder(order.id, { status: 'on_hold', cod_confirmation: 'on_hold' }, 'system', 'COD not allowed by policy');
    addOrderNote(order.id, 'On hold: COD policy check failed (amount/pincode). Needs prepaid conversion or cancellation.', 'system');
  }
  if (risk.codAllowed && s.risk.autoConfirmBelow > 0 && risk.score < s.risk.autoConfirmBelow) {
    confirmCod(order.id, 'system', null, 'auto-confirmed: low risk');
    return;
  }
  await q.add('cod.send_confirmation', { orderId: order.id }, { key: `cod-confirm:${order.id}`, delayMs: s.timings.codConfirmDelaySec * 1000 });
}

export function trustedConversationFor(order: Order, flow: any) {
  // We reach the customer on the phone number used on the order, so the conversation is verified for that order.
  const conv = findOrCreateForPhone(order.phone, config.whatsapp.enabled ? 'whatsapp' : 'web', order.name);
  const verified = [...new Set([...conv.verified_orders, order.id])];
  return updateConversation(conv.id, { verified_phone: order.phone, verified_orders: verified, customer_name: order.name, context_order_id: order.id, flow } as any);
}

export async function sendCodConfirmation(orderId: string) {
  const o = getOrder(orderId);
  if (!o || o.payment_method !== 'cod' || o.cod_confirmation !== 'pending') return;
  const conv = trustedConversationFor(o, { type: 'cod_confirm', orderId: o.id });
  const lang = conv.language as Lang;
  const q = prepaidQuote(o);
  const reply: Reply = { text: t(lang, 'cod_confirm', { name: o.name.split(' ')[0], orderId: o.id, order: o, address: shortAddress(o), prepaid: q.payable }), buttons: codButtons(lang, o.id) };
  const msg = await sendToCustomer(conv.id, reply, { dedupeKey: `cod-confirm:${o.id}`, meta: { kind: 'cod_confirmation', orderId: o.id } });
  if (!msg) return; // already sent
  updateOrder(o.id, { confirmation_sent_at: nowIso() }, 'system');
  const s = getSettings().timings;
  const queue = getQueue();
  await queue.add('cod.reminder', { orderId: o.id }, { key: `cod-reminder:${o.id}`, delayMs: s.codReminderSec * 1000 });
  await queue.add('cod.hold', { orderId: o.id }, { key: `cod-hold:${o.id}`, delayMs: s.codHoldSec * 1000 });
  log.info('cod confirmation sent', { orderId: o.id, conversationId: conv.id });
}

function customerRepliedSince(conversationId: string, sinceIso: string | null) {
  if (!sinceIso) return false;
  return getMessages(conversationId).some((m) => m.role === 'customer' && m.created_at > sinceIso);
}

export async function codReminder(orderId: string) {
  const o = getOrder(orderId);
  if (!o || o.cod_confirmation !== 'pending' || o.reminder_sent_at) return;
  const conv = trustedConversationFor(o, { type: 'cod_confirm', orderId: o.id });
  if (customerRepliedSince(conv.id, o.confirmation_sent_at)) return;
  const lang = conv.language as Lang;
  await sendToCustomer(conv.id, { text: t(lang, 'cod_reminder', { orderId: o.id, total: o.total }), buttons: codButtons(lang, o.id) }, { dedupeKey: `cod-reminder:${o.id}`, meta: { kind: 'cod_reminder', orderId: o.id } });
  updateOrder(o.id, { reminder_sent_at: nowIso() }, 'system');
}

export async function codHold(orderId: string) {
  const o = getOrder(orderId);
  if (!o || o.cod_confirmation !== 'pending') return;
  updateOrder(o.id, { status: 'on_hold', cod_confirmation: 'on_hold' }, 'system', `No reply ${Math.round(getSettings().timings.codHoldSec / 3600 * 10) / 10}h after confirmation request`);
  addOrderNote(o.id, 'Put on hold: customer did not respond to COD confirmation or reminder.', 'system');
  const conv = trustedConversationFor(o, { type: 'cod_confirm', orderId: o.id });
  await sendToCustomer(conv.id, { text: t(conv.language as Lang, 'cod_hold', { orderId: o.id }), buttons: codButtons(conv.language as Lang, o.id) }, { dedupeKey: `cod-hold:${o.id}`, meta: { kind: 'cod_hold', orderId: o.id } });
}

export function confirmCod(orderId: string, actor: string, conversationId: string | null, reason = 'customer confirmed COD order') {
  const o = getOrder(orderId)!;
  updateOrder(o.id, { status: 'confirmed', cod_confirmation: 'confirmed', confirmed_at: nowIso() }, actor, reason, conversationId);
  void getQueue().add('shipment.create', { orderId: o.id }, { key: `ship:${o.id}` });
  if (conversationId) updateConversation(conversationId, { flow: null } as any);
  return getOrder(o.id)!;
}

export function cancelOrder(orderId: string, actor: string, conversationId: string | null, reason: string) {
  const o = getOrder(orderId)!;
  updateOrder(o.id, { status: 'cancelled', cod_confirmation: o.payment_method === 'cod' ? 'cancelled' : o.cod_confirmation, cancel_reason: reason }, actor, reason, conversationId);
  for (const it of o.items) if (it.size) adjustStock(it.sku, it.size, it.qty, actor, `restock: ${o.id} cancelled`);
  if (o.payment_method === 'prepaid') {
    getDb().prepare(`INSERT INTO refunds(id,order_id,return_id,amount,method,status,initiated_at,qc_passed_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(`RFD-${o.id}`, o.id, null, o.total, 'original_payment_method', 'pending', nowIso(), nowIso());
  }
  if (conversationId) updateConversation(conversationId, { flow: null } as any);
  return getOrder(o.id)!;
}

const payToken = (orderId: string) => crypto.createHmac('sha256', config.secrets.orderWebhook).update(`pay:${orderId}`).digest('hex').slice(0, 24);
export const paymentLink = (orderId: string) => `${config.frontendUrl}/pay/${orderId}?t=${payToken(orderId)}`;

export function paymentInfo(orderId: string, token: string) {
  const o = getOrder(orderId);
  if (!o || token !== payToken(orderId)) return null;
  return { orderId: o.id, name: o.name, items: o.items, payment_method: o.payment_method, status: o.status, cod_total: o.total, shipping_fee: o.shipping_fee, cod_fee: o.cod_fee, existing_discount: o.discount, ...prepaidQuote(o) };
}

/** Dummy payment gateway success → convert the COD order to prepaid with 5% off and no COD fee. */
export async function completePrepaid(orderId: string, token: string) {
  const o = getOrder(orderId);
  if (!o || token !== payToken(orderId)) throw Object.assign(new Error('Invalid payment link'), { status: 403 });
  if (o.payment_method === 'prepaid') return o; // idempotent
  if (!PRE_DISPATCH.includes(o.status as any)) throw Object.assign(new Error('Order already dispatched'), { status: 409 });
  const q = prepaidQuote(o);
  updateOrder(o.id, { payment_method: 'prepaid', cod_fee: 0, discount: (o.discount || 0) + q.discount, total: q.payable, cod_confirmation: 'switched_prepaid', status: 'confirmed', confirmed_at: nowIso() }, 'customer', 'switched to prepaid via payment link');
  addOrderNote(o.id, `Customer paid ₹${q.payable} online (5% prepaid discount). Saved from COD.`, 'system');
  await getQueue().add('shipment.create', { orderId: o.id }, { key: `ship:${o.id}` });
  const conv = trustedConversationFor(getOrder(o.id)!, null);
  await sendToCustomer(conv.id, { text: t(conv.language as Lang, 'cod_prepaid_done', { orderId: o.id, paid: q.payable }) }, { dedupeKey: `prepaid-done:${o.id}` });
  return getOrder(o.id)!;
}

export async function createShipmentFor(orderId: string) {
  const o = getOrder(orderId);
  if (!o || o.awb || o.status !== 'confirmed') return;
  const r = await courier.createShipment(o.id, { name: o.name, phone: o.phone, address: shortAddress(o), pincode: o.pincode, city: o.city });
  updateOrder(o.id, { awb: r.awb, courier: 'SwiftShip' }, 'system', 'shipment created with courier');
}

export function getPendingConversationOrder(conversationId: string) {
  const c = getConversation(conversationId);
  return c?.flow?.orderId ? getOrder(c.flow.orderId) : null;
}
