/**
 * Webhook intake. The HTTP handler only: verifies the HMAC, records the event id (unique) and enqueues a job.
 * A duplicate delivery (same event id) is acknowledged with 200 and does nothing. Further down, the order id,
 * job keys and message dedupe keys make the side effects idempotent even if an event id changes.
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import { getDb, nowIso } from '../db/index.js';
import { getQueue } from '../queue/index.js';
import { log } from '../lib/logger.js';
import { normalizePhone } from '../lib/pii.js';
import { getOrder, insertOrder, type NewOrderInput } from './orders.js';
import { onOrderCreated } from './cod.js';
import { handleCourierEvent } from './ndr.js';

/** Returns true if this (source, event) is new; false for a duplicate delivery. */
export function recordWebhookEvent(source: string, eventId: string, topic?: string) {
  const r = getDb().prepare(`INSERT OR IGNORE INTO webhook_events(source,event_id,topic,status,received_at) VALUES (?,?,?,?,?)`).run(source, eventId, topic ?? null, 'queued', nowIso());
  if (r.changes === 0) {
    getDb().prepare('UPDATE webhook_events SET attempts=attempts+1 WHERE source=? AND event_id=?').run(source, eventId);
    log.info('duplicate webhook ignored', { source, eventId });
    return false;
  }
  return true;
}
export const markWebhook = (source: string, eventId: string, status: string) =>
  getDb().prepare('UPDATE webhook_events SET status=? WHERE source=? AND event_id=?').run(status, source, eventId);

export const eventIdFor = (header: string | undefined, body: Buffer) => header || `sha256:${crypto.createHash('sha256').update(body).digest('hex').slice(0, 32)}`;

export const OrderPayload = z.object({
  id: z.string().regex(/^#?(WL)?\d{5}$/i).transform((s) => `WL${s.replace(/\D/g, '')}`),
  created_at: z.string().optional(),
  customer: z.object({ name: z.string().min(1).max(80), phone: z.string().min(10).max(16), email: z.string().email().optional().nullable() }),
  shipping_address: z.object({ line1: z.string().min(3).max(250), line2: z.string().max(250).optional().nullable(), landmark: z.string().max(120).optional().nullable(), city: z.string().max(60).optional().nullable(), state: z.string().max(60).optional().nullable(), pincode: z.string().regex(/^\d{6}$/) }),
  payment_method: z.enum(['cod', 'prepaid']),
  line_items: z.array(z.object({ sku: z.string(), size: z.string().optional().nullable(), qty: z.number().int().min(1).max(50), price: z.number().optional() })).min(1),
  discount: z.number().min(0).optional(),
  total: z.number().positive().optional(),
});
export type OrderPayloadT = z.infer<typeof OrderPayload>;

/** Maps a Shopify `orders/create` payload into our order shape. */
export function fromShopify(s: any): OrderPayloadT {
  const addr = s.shipping_address ?? s.billing_address ?? {};
  const gateways: string[] = s.payment_gateway_names ?? [s.gateway].filter(Boolean);
  const cod = gateways.some((g) => /cash on delivery|cod/i.test(g)) || s.financial_status === 'pending';
  return OrderPayload.parse({
    id: `WL${String(s.order_number ?? s.number ?? String(s.name).replace(/\D/g, '')).padStart(5, '0').slice(-5)}`,
    created_at: s.created_at,
    customer: { name: [addr.first_name ?? s.customer?.first_name, addr.last_name ?? s.customer?.last_name].filter(Boolean).join(' ') || 'Customer', phone: addr.phone ?? s.phone ?? s.customer?.phone ?? '', email: s.email ?? s.customer?.email ?? null },
    shipping_address: { line1: addr.address1 ?? '', line2: addr.address2 ?? null, city: addr.city ?? null, state: addr.province ?? null, pincode: String(addr.zip ?? '').replace(/\s/g, '') },
    payment_method: cod ? 'cod' : 'prepaid',
    line_items: (s.line_items ?? []).map((li: any) => ({ sku: li.sku || 'UNKNOWN', size: li.variant_title ?? null, qty: li.quantity ?? 1, price: Number(li.price) })),
    discount: Number(s.total_discounts ?? 0) || undefined,
    total: Number(s.total_price) || undefined,
  });
}

export async function processOrderWebhook(p: OrderPayloadT, source = 'webhook') {
  const input: NewOrderInput = {
    id: p.id, name: p.customer.name, phone: normalizePhone(p.customer.phone), email: p.customer.email ?? null,
    address_line1: p.shipping_address.line1, address_line2: p.shipping_address.line2 ?? null, landmark: p.shipping_address.landmark ?? null,
    city: p.shipping_address.city ?? null, state: p.shipping_address.state ?? null, pincode: p.shipping_address.pincode,
    payment_method: p.payment_method, items: p.line_items.map((l) => ({ sku: l.sku, size: l.size ?? null, qty: l.qty, price: l.price })),
    created_at: p.created_at, source,
  };
  const { order, created } = insertOrder(input);
  if (!created) { log.info('order already exists — ignoring repeat webhook', { orderId: order.id }); return { orderId: order.id, created: false }; }
  if (p.discount || p.total) {
    // trust the store's computed total when given (coupons etc.)
    const total = p.total ?? order.total - (p.discount ?? 0);
    const discount = p.discount ?? Math.max(0, order.subtotal + order.shipping_fee + order.cod_fee - total);
    getDb().prepare('UPDATE orders SET total=?, discount=? WHERE id=?').run(total, discount, order.id);
  }
  await onOrderCreated(getOrder(order.id)!);
  return { orderId: order.id, created: true };
}

export async function enqueueOrderWebhook(eventId: string, payload: OrderPayloadT, source: string) {
  await getQueue().add('webhook.order', { eventId, payload, source }, { key: `whk-order:${eventId}` });
}
export async function enqueueCourierWebhook(eventId: string, payload: any) {
  await getQueue().add('webhook.courier', { eventId, payload }, { key: `whk-courier:${eventId}` });
}
export { handleCourierEvent };
