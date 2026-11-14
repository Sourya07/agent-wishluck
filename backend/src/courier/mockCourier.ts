/**
 * Mock courier ("SwiftShip"). Behaves like a third-party logistics API:
 *  - keeps its own shipment table + timeline,
 *  - exposes REST endpoints for creating shipments, tracking and NDR instructions,
 *  - pushes HMAC-signed status webhooks to our /webhooks/courier endpoint (with retries).
 * Our app only ever talks to it over HTTP (see services/courierClient.ts), so it can be swapped for a real courier.
 */
import { Router, json as jsonBody } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { getDb, json, nowIso } from '../db/index.js';
import { config } from '../config.js';
import { signHex } from '../lib/hmac.js';
import { fetchJson } from '../lib/http.js';
import { log } from '../lib/logger.js';
import { getSettings } from '../settings.js';

export const COURIER_STATUSES = ['manifested', 'picked_up', 'in_transit', 'out_for_delivery', 'delivery_failed', 'delivered', 'rto_initiated', 'rto_delivered'] as const;
export const NDR_REASONS = ['Customer not available', 'Customer refused delivery', 'Incomplete address', 'Address not found', 'Customer phone switched off', 'Customer asked to reschedule', 'Entry restricted / gated society', 'COD amount not ready'];

interface TimelineEntry { at: string; status: string; note?: string; location?: string }

const db = () => getDb();
const getShipment = (awb: string) => {
  const r = db().prepare('SELECT * FROM courier_shipments WHERE awb=?').get(awb) as any;
  return r ? { ...r, consignee: json(r.consignee, {}), timeline: json<TimelineEntry[]>(r.timeline, []) } : null;
};
const save = (s: any) => db().prepare('UPDATE courier_shipments SET status=?, attempts=?, consignee=?, scheduled_date=?, timeline=?, updated_at=? WHERE awb=?')
  .run(s.status, s.attempts, JSON.stringify(s.consignee), s.scheduled_date ?? null, JSON.stringify(s.timeline), nowIso(), s.awb);

const CITIES = ['Delhi hub', 'Lucknow hub', 'Kanpur sorting centre', 'Gorakhpur DC', 'Mumbai hub', 'Bengaluru hub'];

export function createShipmentRecord(orderId: string, consignee: any, createdAt = nowIso()) {
  const awb = `SS${Math.floor(1e9 + Math.random() * 9e9)}`;
  db().prepare('INSERT INTO courier_shipments(awb,order_id,status,attempts,consignee,timeline,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(awb, orderId, 'manifested', 0, JSON.stringify(consignee), JSON.stringify([{ at: createdAt, status: 'manifested', note: 'Shipment created' }]), createdAt, createdAt);
  return awb;
}

async function sendWebhook(payload: any) {
  const body = JSON.stringify(payload);
  const sig = `sha256=${signHex(config.secrets.courierWebhook, body)}`;
  return fetchJson(config.courier.webhookTarget, {
    method: 'POST', body, timeoutMs: 5000, retries: 3, label: 'courier→webhook',
    headers: { 'x-courier-signature': sig, 'x-courier-event-id': payload.event_id },
  });
}

/** Apply a status event to a shipment and emit the webhook. Exported for seed/tests. */
export async function applyCourierEvent(awb: string, status: string, opts: { reason?: string; location?: string; duplicate?: boolean; emit?: boolean } = {}) {
  const s = getShipment(awb);
  if (!s) throw Object.assign(new Error('AWB not found'), { status: 404 });
  const at = nowIso();
  if (status === 'delivery_failed') s.attempts += 1;
  s.status = status;
  const location = opts.location ?? CITIES[Math.floor(Math.random() * CITIES.length)];
  s.timeline.push({ at, status, note: opts.reason, location });
  save(s);
  const payload = { event_id: `evt_${crypto.randomBytes(8).toString('hex')}`, awb, order_id: s.order_id, status, reason: opts.reason ?? null, attempt: s.attempts, location, occurred_at: at };
  if (opts.emit !== false) {
    await sendWebhook(payload);
    if (opts.duplicate) await sendWebhook(payload); // same event id → must be ignored downstream
  }
  return { shipment: getShipment(awb), event: payload };
}

const NdrSchema = z.object({
  action: z.enum(['reschedule', 'update_address', 'update_phone', 'rto']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  address: z.string().min(5).max(300).optional(),
  landmark: z.string().max(120).optional(),
  pincode: z.string().regex(/^\d{6}$/).optional(),
  phone: z.string().regex(/^[6-9]\d{9}$/).optional(),
  reason: z.string().max(300).optional(),
});

export function mockCourierRouter() {
  const r = Router();
  r.use(jsonBody());
  // Simulated outage so we can test "tool failed → agent offers callback".
  r.use((_req, res, next) => {
    if (getSettings().simulation.courierOutage) return res.status(503).json({ error: 'courier API unavailable (simulated outage)' });
    next();
  });

  r.post('/shipments', (req, res) => {
    const b = z.object({ order_id: z.string(), consignee: z.record(z.string(), z.any()) }).safeParse(req.body);
    if (!b.success) return res.status(400).json({ error: b.error.issues });
    const existing = db().prepare('SELECT awb FROM courier_shipments WHERE order_id=?').get(b.data.order_id) as any;
    if (existing) return res.json({ awb: existing.awb, existing: true });
    res.status(201).json({ awb: createShipmentRecord(b.data.order_id, b.data.consignee) });
  });

  r.get('/shipments/:awb', (req, res) => {
    const s = getShipment(req.params.awb);
    if (!s) return res.status(404).json({ error: 'AWB not found' });
    res.json({ awb: s.awb, order_id: s.order_id, status: s.status, attempts: s.attempts, scheduled_date: s.scheduled_date, timeline: s.timeline, courier: 'SwiftShip' });
  });

  r.post('/shipments/:awb/events', async (req, res) => {
    const b = z.object({ status: z.enum(COURIER_STATUSES), reason: z.string().max(200).optional(), location: z.string().max(80).optional(), duplicate: z.boolean().optional() }).safeParse(req.body);
    if (!b.success) return res.status(400).json({ error: b.error.issues });
    if (b.data.status === 'delivery_failed' && !b.data.reason) b.data.reason = NDR_REASONS[0];
    try {
      const out = await applyCourierEvent(req.params.awb, b.data.status, b.data);
      res.json(out);
    } catch (e: any) {
      log.error('courier event failed', { error: e.message });
      res.status(e.status ?? 502).json({ error: e.message });
    }
  });

  r.post('/shipments/:awb/ndr', (req, res) => {
    const s = getShipment(req.params.awb);
    if (!s) return res.status(404).json({ error: 'AWB not found' });
    const b = NdrSchema.safeParse(req.body);
    if (!b.success) return res.status(400).json({ error: b.error.issues });
    const a = b.data;
    let note = '';
    if (a.action === 'reschedule') { s.scheduled_date = a.date; note = `Re-attempt scheduled for ${a.date}`; s.status = 'in_transit'; }
    if (a.action === 'update_address') { s.consignee = { ...s.consignee, address: a.address ?? s.consignee.address, landmark: a.landmark ?? s.consignee.landmark, pincode: a.pincode ?? s.consignee.pincode }; note = 'Consignee address / landmark updated'; s.status = 'in_transit'; }
    if (a.action === 'update_phone') { s.consignee = { ...s.consignee, alternate_phone: a.phone }; note = 'Alternate phone added'; s.status = 'in_transit'; }
    if (a.action === 'rto') { s.status = 'rto_initiated'; note = `RTO requested by seller${a.reason ? `: ${a.reason}` : ''}`; }
    s.timeline.push({ at: nowIso(), status: a.action === 'rto' ? 'rto_initiated' : 'ndr_instruction', note });
    save(s);
    res.json({ ok: true, awb: s.awb, status: s.status, note });
  });

  r.get('/meta', (_req, res) => res.json({ statuses: COURIER_STATUSES, ndrReasons: NDR_REASONS }));
  return r;
}
