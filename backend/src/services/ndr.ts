/**
 * Courier status webhooks + failed-delivery (NDR) follow-up.
 * delivery_failed → message the customer with the courier's reason (job, deduped per AWB+attempt)
 *   → capture new date (next 3 days) / corrected address or landmark / alternate phone / "don't want it"
 *   → push the instruction to the courier API + note on the order
 *   → no response: one reminder; if ≥2 attempts failed and still silent → hand over to a person.
 */
import { nowIso } from '../db/index.js';
import { log } from '../lib/logger.js';
import { istDate } from '../lib/time.js';
import { getQueue } from '../queue/index.js';
import { getSettings } from '../settings.js';
import { t, type Button, type Reply } from '../agent/templates.js';
import type { Lang } from '../agent/nlu.js';
import { handover } from '../agent/handover.js';
import { courier } from './courierClient.js';
import { getMessages, updateConversation } from './conversations.js';
import { sendToCustomer } from './messaging.js';
import { addOrderNote, getOrder, getOrderByAwb, updateOrder } from './orders.js';
import { trustedConversationFor } from './cod.js';
import { POLICY } from '../policy/policy.js';

const STATUS_MAP: Record<string, string> = {
  picked_up: 'shipped', in_transit: 'in_transit', out_for_delivery: 'out_for_delivery', delivery_failed: 'delivery_failed',
  delivered: 'delivered', rto_initiated: 'rto_initiated', rto_delivered: 'rto_delivered',
};

export interface CourierEvent { event_id: string; awb: string; order_id?: string; status: string; reason?: string | null; attempt?: number; location?: string; occurred_at?: string }

export async function handleCourierEvent(ev: CourierEvent) {
  const o = getOrderByAwb(ev.awb) ?? (ev.order_id ? getOrder(ev.order_id) : null);
  if (!o) { log.warn('courier event for unknown AWB', { awb: ev.awb }); return; }
  const next = STATUS_MAP[ev.status];
  if (!next) return;
  const patch: Record<string, any> = { status: next };
  if (ev.status === 'picked_up' && !o.shipped_at) patch.shipped_at = ev.occurred_at ?? nowIso();
  if (ev.status === 'delivered') { patch.delivered_at = ev.occurred_at ?? nowIso(); if (o.ndr_status === 'open' || o.ndr_status === 'action_taken') patch.ndr_status = 'delivered_after_ndr'; }
  if (ev.status === 'delivery_failed') { patch.ndr_attempts = Math.max(o.ndr_attempts + 1, ev.attempt ?? 0); patch.ndr_reason = ev.reason ?? 'Delivery failed'; patch.ndr_status = 'open'; }
  if (ev.status === 'rto_initiated' && !o.rto_reason) patch.rto_reason = ev.reason ?? 'Courier initiated RTO';
  updateOrder(o.id, patch, 'courier', `courier event ${ev.status}${ev.reason ? `: ${ev.reason}` : ''}`);
  if (ev.status === 'delivery_failed') {
    await getQueue().add('ndr.contact', { orderId: o.id, attempt: patch.ndr_attempts }, { key: `ndr-contact:${ev.awb}:${patch.ndr_attempts}` });
  }
}

export const ndrButtons = (lang: Lang, orderId: string): Button[] => [
  { id: `ndr:reschedule:${orderId}`, label: t(lang, 'b_resched') },
  { id: `ndr:address:${orderId}`, label: t(lang, 'b_addr') },
  { id: `ndr:phone:${orderId}`, label: t(lang, 'b_phone') },
  { id: `ndr:rto:${orderId}`, label: t(lang, 'b_rto') },
];

/** Next 3 days (IST) as date buttons. */
export const ndrDateButtons = (orderId: string, now = Date.now()): Button[] => [1, 2, 3].map((n) => {
  const d = istDate(now + n * 86_400_000);
  const label = new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return { id: `ndr_date:${d}:${orderId}`, label };
});
export const allowedNdrDates = (now = Date.now()) => [1, 2, 3].map((n) => istDate(now + n * 86_400_000));

export async function ndrContact(orderId: string, attempt: number) {
  const o = getOrder(orderId);
  if (!o || o.status !== 'delivery_failed') return;
  const conv = trustedConversationFor(o, { type: 'ndr', orderId: o.id });
  const lang = conv.language as Lang;
  const reply: Reply = { text: t(lang, 'ndr', { name: o.name.split(' ')[0], orderId: o.id, reason: o.ndr_reason }), buttons: ndrButtons(lang, o.id) };
  const msg = await sendToCustomer(conv.id, reply, { dedupeKey: `ndr-contact:${o.id}:${attempt}`, meta: { kind: 'ndr', orderId: o.id, attempt } });
  if (!msg) return;
  updateOrder(o.id, { ndr_contacted_at: nowIso() }, 'system');
  const s = getSettings().timings;
  await getQueue().add('ndr.reminder', { orderId: o.id, attempt }, { key: `ndr-reminder:${o.id}:${attempt}`, delayMs: s.ndrReminderSec * 1000 });
  await getQueue().add('ndr.escalate', { orderId: o.id, attempt }, { key: `ndr-escalate:${o.id}:${attempt}`, delayMs: s.ndrEscalateSec * 1000 });
}

function respondedSince(conversationId: string, since: string | null) {
  return !!since && getMessages(conversationId).some((m) => m.role === 'customer' && m.created_at > since);
}

export async function ndrReminder(orderId: string, attempt: number) {
  const o = getOrder(orderId);
  if (!o || o.ndr_status !== 'open' || o.ndr_attempts !== attempt) return;
  const conv = trustedConversationFor(o, { type: 'ndr', orderId: o.id });
  if (respondedSince(conv.id, o.ndr_contacted_at)) return;
  const lang = conv.language as Lang;
  await sendToCustomer(conv.id, { text: t(lang, 'ndr_reminder', { orderId: o.id, reason: o.ndr_reason }), buttons: ndrButtons(lang, o.id) }, { dedupeKey: `ndr-reminder:${o.id}:${attempt}` });
}

export async function ndrEscalate(orderId: string, attempt: number) {
  const o = getOrder(orderId);
  if (!o || o.ndr_status !== 'open' || o.ndr_attempts !== attempt) return;
  const conv = trustedConversationFor(o, { type: 'ndr', orderId: o.id });
  if (respondedSince(conv.id, o.ndr_contacted_at)) return;
  if (o.ndr_attempts >= 2) {
    updateOrder(o.id, { ndr_status: 'escalated' }, 'system', 'no response after 2 failed attempts');
    await handover(conv.id, { code: 'ndr_no_response', reason: `${o.ndr_attempts} delivery attempts failed (last: "${o.ndr_reason}") and the customer has not responded.`, orderId: o.id, notify: true });
  }
}

/** Customer chose an NDR action. Pushes to the courier API, notes it on the order. Throws if courier is down. */
export async function ndrApply(orderId: string, action: 'reschedule' | 'update_address' | 'update_phone' | 'rto', data: Record<string, any>, actor: string, conversationId: string | null) {
  const o = getOrder(orderId);
  if (!o?.awb) throw new Error('Order has no shipment');
  await courier.ndr(o.awb, { action, ...data });
  const human: Record<string, string> = {
    reschedule: `Re-attempt scheduled for ${data.date}`,
    update_address: `Address/landmark corrected: ${[data.address, data.landmark, data.pincode].filter(Boolean).join(', ')}`,
    update_phone: 'Alternate phone shared with courier',
    rto: `Customer does not want the order — RTO requested. Reason: ${data.reason ?? 'not given'}`,
  };
  const patch: Record<string, any> = { ndr_status: action === 'rto' ? 'rto_requested' : 'action_taken', ndr_resolution: human[action] };
  if (action === 'rto') { patch.status = 'rto_initiated'; patch.rto_reason = data.reason ?? 'customer declined after failed delivery'; }
  if (action === 'update_address') {
    if (data.address) patch.address_line1 = data.address;
    if (data.landmark) patch.landmark = data.landmark;
    if (data.pincode) patch.pincode = data.pincode;
  }
  if (action === 'reschedule' || action === 'update_address' || action === 'update_phone') patch.status = 'in_transit';
  updateOrder(o.id, patch, actor, human[action], conversationId);
  addOrderNote(o.id, `NDR: ${human[action]}`, actor);
  if (conversationId) updateConversation(conversationId, { flow: null } as any);
  return getOrder(o.id)!;
}

export const rtoRefundIfRefused = (total: number) => Math.max(0, total - POLICY.refuseDeliveryShippingDeduction);
