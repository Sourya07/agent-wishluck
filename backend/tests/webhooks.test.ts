import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db/index.js';
import { signBase64, signHex } from '../src/lib/hmac.js';
import { useSqliteQueue } from '../src/queue/index.js';
import { jobHandlers } from '../src/queue/jobs.js';
import { seed } from '../src/services/seed.js';
import { updateSettings } from '../src/settings.js';

const app = createApp();
const queue = useSqliteQueue();
beforeAll(() => queue.start(jobHandlers, { poll: false }));
beforeEach(() => { seed({ reset: true }); updateSettings({ timings: { codConfirmDelaySec: 0 } }); });

const order = (id: string, phone = '9123499999') => ({ id, customer: { name: 'Test Buyer', phone }, shipping_address: { line1: 'Flat 3, Green Park Apartments', pincode: '226010' }, payment_method: 'cod', line_items: [{ sku: 'WL-TEE-02', size: 'M', qty: 1 }] });
const post = (body: string, eventId: string, sig = signBase64(config.secrets.orderWebhook, body)) =>
  request(app).post('/webhooks/orders').set('content-type', 'application/json').set('x-wishluck-hmac-sha256', sig).set('x-wishluck-webhook-id', eventId).send(body);
const count = (sql: string, ...a: any[]) => (getDb().prepare(sql).get(...a) as any).c;

describe('order webhook', () => {
  it('rejects a bad signature', async () => {
    const body = JSON.stringify(order('WL10500'));
    const r = await post(body, 'evt-1', 'bm90LXRoZS1zaWduYXR1cmU=');
    expect(r.status).toBe(401);
    expect(count(`SELECT COUNT(*) c FROM orders WHERE id='WL10500'`)).toBe(0);
  });

  it('rejects an invalid payload with 422', async () => {
    const body = JSON.stringify({ id: 'WL10501', customer: { name: 'x' } });
    expect((await post(body, 'evt-2')).status).toBe(422);
  });

  it('same event delivered twice → one order, one confirmation message', async () => {
    const body = JSON.stringify(order('WL10502'));
    const a = await post(body, 'evt-3');
    const b = await post(body, 'evt-3');
    expect(a.status).toBe(202);
    expect(b.status).toBe(200);
    expect(b.body.duplicate).toBe(true);
    await queue.drain!();
    expect(count(`SELECT COUNT(*) c FROM orders WHERE id='WL10502'`)).toBe(1);
    expect(count(`SELECT COUNT(*) c FROM messages WHERE dedupe_key='cod-confirm:WL10502'`)).toBe(1);
  });

  it('same order with a NEW event id is still processed once (order id + job keys dedupe)', async () => {
    const body = JSON.stringify(order('WL10503'));
    await post(body, 'evt-4');
    await post(body, 'evt-5');
    await queue.drain!();
    await queue.drain!();
    expect(count(`SELECT COUNT(*) c FROM orders WHERE id='WL10503'`)).toBe(1);
    expect(count(`SELECT COUNT(*) c FROM messages WHERE content LIKE '%WL10503%'`)).toBe(1);
  });

  it('scores the order and records an audit trail', async () => {
    await post(JSON.stringify(order('WL10504')), 'evt-6');
    await queue.drain!();
    const o = getDb().prepare(`SELECT * FROM orders WHERE id='WL10504'`).get() as any;
    expect(o.risk_band).toBeTruthy();
    expect(JSON.parse(o.risk_reasons).length).toBeGreaterThan(0);
    expect(count(`SELECT COUNT(*) c FROM audit_log WHERE entity_id='WL10504' AND field='risk_score'`)).toBe(1);
  });

  it('accepts Shopify orders/create payloads with X-Shopify-Hmac-Sha256', async () => {
    (config.secrets as any).shopifyWebhook = 'shpss_test';
    const s = { id: 555, order_number: 1042, created_at: new Date().toISOString(), total_price: '1378.00', payment_gateway_names: ['Cash on Delivery (COD)'], email: 'a@example.com',
      shipping_address: { first_name: 'Asha', last_name: 'Rai', address1: 'House 9, Lane 2, Ashok Nagar', city: 'Lucknow', province: 'UP', zip: '226010', phone: '+91 91234 11111' },
      line_items: [{ sku: 'WL-KUR-01', quantity: 1, price: '1299.00', variant_title: 'L' }] };
    const body = JSON.stringify(s);
    const r = await request(app).post('/webhooks/orders').set('content-type', 'application/json').set('x-shopify-hmac-sha256', signBase64('shpss_test', body)).set('x-shopify-webhook-id', 'shp-1').send(body);
    expect(r.status).toBe(202);
    await queue.drain!();
    const o = getDb().prepare(`SELECT * FROM orders WHERE id='WL01042'`).get() as any;
    expect(o).toMatchObject({ payment_method: 'cod', phone: '9123411111', pincode: '226010', source: 'shopify' });
  });
});

describe('courier webhook', () => {
  const ev = (event_id: string) => JSON.stringify({ event_id, awb: (getDb().prepare(`SELECT awb FROM orders WHERE id='WL10236'`).get() as any).awb, status: 'delivery_failed', reason: 'Customer not available', attempt: 1 });
  const postC = (body: string, sig = `sha256=${signHex(config.secrets.courierWebhook, body)}`) =>
    request(app).post('/webhooks/courier').set('content-type', 'application/json').set('x-courier-signature', sig).send(body);

  it('rejects unsigned events', async () => {
    expect((await postC(ev('c-0'), 'sha256=deadbeef')).status).toBe(401);
  });
  it('duplicate delivery_failed → one NDR message, attempts counted once', async () => {
    const body = ev('c-1');
    await postC(body);
    await postC(body);
    await queue.drain!();
    expect(count(`SELECT ndr_attempts c FROM orders WHERE id='WL10236'`)).toBe(1);
    expect(count(`SELECT COUNT(*) c FROM messages WHERE dedupe_key LIKE 'ndr-contact:WL10236:%'`)).toBe(1);
    expect(count(`SELECT COUNT(*) c FROM webhook_events WHERE event_id='c-1' AND attempts=2`)).toBe(1);
  });
});
