import { Router, json as jsonBody, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { config, llmConfigured } from '../config.js';
import { getDb, json, nowIso } from '../db/index.js';
import { bus, type BusEvent } from '../lib/events.js';
import { signBase64 } from '../lib/hmac.js';
import { fetchJson } from '../lib/http.js';
import { uid } from '../lib/ids.js';
import { maskPhone } from '../lib/pii.js';
import { handleCustomerMessage, sendHumanMessage } from '../agent/engine.js';
import { HANDOVER_LABELS } from '../agent/handover.js';
import { createConversation, getConversation, getMessages, getToolCalls, listConversations, updateConversation } from '../services/conversations.js';
import { addOrderNote, getAudit, getOrder, listOrders, updateOrder } from '../services/orders.js';
import { cancelOrder, completePrepaid, confirmCod, paymentInfo, sendCodConfirmation } from '../services/cod.js';
import { courier } from '../services/courierClient.js';
import { analytics } from '../services/analytics.js';
import { refundView } from '../services/returns.js';
import { COURIER_STATUSES, NDR_REASONS } from '../courier/mockCourier.js';
import { PRODUCTS } from '../policy/catalog.js';
import { DEFAULT_SETTINGS, FAST_TIMINGS, getSettings, updateSettings } from '../settings.js';
import { getQueue } from '../queue/index.js';
import { seed } from '../services/seed.js';

const wrap = (fn: (req: Request, res: Response) => Promise<any> | any) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).catch(next);

const customerMessage = (m: any) => ({ id: m.id, role: m.role, content: m.content, buttons: m.meta?.buttons ?? [], created_at: m.created_at });

function sse(res: Response) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write(': connected\n\n');
  const hb = setInterval(() => res.write(': ping\n\n'), 20000);
  return () => clearInterval(hb);
}

/** Optional shared-secret guard for the internal dashboard API. */
function dashboardAuth(req: Request, res: Response, next: NextFunction) {
  if (!config.secrets.dashboardToken) return next();
  const tok = req.header('x-dashboard-token') ?? (req.query.token as string | undefined);
  if (tok === config.secrets.dashboardToken) return next();
  res.status(401).json({ error: 'dashboard token required' });
}

let lastIssued = 0;
/** Test orders are processed asynchronously, so remember ids we've handed out but not stored yet. */
function nextOrderId() {
  const r = getDb().prepare(`SELECT MAX(CAST(substr(id,3) AS INTEGER)) n FROM orders WHERE id LIKE 'WL1%'`).get() as { n: number | null };
  lastIssued = Math.max(10300, (r.n ?? 0) + 1, lastIssued + 1);
  return `WL${lastIssued}`;
}

const PRESETS: Record<string, any> = {
  low_risk: { customer: { name: 'Rohan Mehta', phone: '9820022002' }, shipping_address: { line1: 'Flat 1204, Tower B, Hiranandani Gardens, Powai', city: 'Mumbai', pincode: '400076' }, payment_method: 'cod', line_items: [{ sku: 'WL-TEE-02', size: 'M', qty: 1 }] },
  high_risk: { customer: { name: 'Bhola Prasad', phone: '' }, shipping_address: { line1: 'near Shiv mandir', city: 'Gorakhpur', pincode: '273001' }, payment_method: 'cod', line_items: [{ sku: 'WL-JNS-03', size: '32', qty: 2 }, { sku: 'WL-KUR-01', size: 'L', qty: 1 }], discount: 346, total: 4600 },
  repeat_refuser: { customer: { name: 'Manish Tiwari', phone: '9792012312' }, shipping_address: { line1: 'Mohalla Bashartpur, near masjid', city: 'Gorakhpur', pincode: '273001' }, payment_method: 'cod', line_items: [{ sku: 'WL-KUR-01', size: 'M', qty: 1 }] },
  prepaid: { customer: { name: 'Ananya Sharma', phone: '9810011001' }, shipping_address: { line1: 'B-42, Second Floor, Mayur Vihar Phase 1', city: 'Delhi', pincode: '110092' }, payment_method: 'prepaid', line_items: [{ sku: 'WL-JNS-03', size: '30', qty: 1 }] },
};
const randomPhone = () => `9${Math.floor(100000000 + Math.random() * 899999999)}`;

export async function postSignedOrderWebhook(payload: any, opts: { duplicate?: boolean } = {}) {
  const body = JSON.stringify(payload);
  const eventId = `evt_${uid()}`;
  const headers = { 'x-wishluck-hmac-sha256': signBase64(config.secrets.orderWebhook, body), 'x-wishluck-webhook-id': eventId };
  const url = `http://127.0.0.1:${config.port}/webhooks/orders`;
  const first = await fetchJson(url, { method: 'POST', body, headers, retries: 1, label: 'self→orders webhook' });
  const second = opts.duplicate ? await fetchJson(url, { method: 'POST', body, headers, retries: 1, label: 'self→orders webhook (dup)' }) : null;
  return { first, second, eventId };
}

export function apiRouter() {
  const r = Router();
  r.use(jsonBody({ limit: '200kb' }));

  r.get('/health', wrap(async (_req, res) => res.json({ ok: true, queue: getQueue().driver, llm: { provider: config.llm.provider, model: config.llm.model, configured: llmConfigured(), enabled: getSettings().agent.llmEnabled }, whatsapp: config.whatsapp.enabled, time: nowIso() })));

  // ------------------------------------------------------------------ customer chat (widget)
  r.post('/chat', wrap(async (req, res) => {
    const c = createConversation({ channel: 'web', customer_name: req.body?.name ?? null });
    res.status(201).json({ conversationId: c.id });
  }));
  r.get('/chat/:id/messages', wrap(async (req, res) => {
    const c = getConversation(String(req.params.id));
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json({ conversationId: c.id, status: c.status, messages: getMessages(c.id).filter((m) => m.role !== 'system').map(customerMessage) });
  }));
  r.post('/chat/:id/messages', wrap(async (req, res) => {
    const b = z.object({ text: z.string().max(2000).default(''), payload: z.string().max(200).optional(), clientMessageId: z.string().max(80).optional() }).safeParse(req.body);
    if (!b.success) return res.status(400).json({ error: b.error.issues });
    if (!b.data.text.trim() && !b.data.payload) return res.status(400).json({ error: 'text or payload required' });
    const out = await handleCustomerMessage(String(req.params.id), b.data.text, { payload: b.data.payload, clientMessageId: b.data.clientMessageId });
    res.json({ reply: out.reply, paused: !!out.paused, duplicate: !!out.duplicate, handover: !!out.handover });
  }));
  r.get('/chat/:id/stream', (req, res) => {
    const id = String(req.params.id);
    const stop = sse(res);
    const on = (e: BusEvent) => {
      if (e.type === 'message.created' && e.conversationId === id && e.message.role !== 'system') res.write(`data: ${JSON.stringify({ type: 'message', message: customerMessage(e.message) })}\n\n`);
      if (e.type === 'conversation.updated' && e.conversationId === id) res.write(`data: ${JSON.stringify({ type: 'status', status: getConversation(id)?.status })}\n\n`);
    };
    bus.on('event', on);
    req.on('close', () => { stop(); bus.off('event', on); });
  });

  // ------------------------------------------------------------------ payments (dummy gateway) + public tracking
  r.get('/payments/:orderId', wrap(async (req, res) => {
    const p = paymentInfo(String(req.params.orderId), String(req.query.t ?? ''));
    if (!p) return res.status(404).json({ error: 'invalid link' });
    res.json(p);
  }));
  r.post('/payments/:orderId/complete', wrap(async (req, res) => {
    const o = await completePrepaid(String(req.params.orderId), String(req.body?.t ?? ''));
    res.json({ ok: true, orderId: o.id, paid: o.total });
  }));
  r.get('/track/:awb', wrap(async (req, res) => {
    try { res.json(await courier.track(String(req.params.awb))); } catch (e: any) { res.status(502).json({ error: 'tracking unavailable', detail: e.message }); }
  }));

  // ------------------------------------------------------------------ dashboard (internal)
  const d = Router();
  d.use(dashboardAuth);

  d.get('/stream', (req, res) => {
    const stop = sse(res);
    const on = (e: BusEvent) => res.write(`data: ${JSON.stringify(e.type === 'message.created' ? { type: e.type, conversationId: e.conversationId } : e)}\n\n`);
    bus.on('event', on);
    req.on('close', () => { stop(); bus.off('event', on); });
  });

  d.get('/conversations', wrap(async (req, res) => {
    const list = listConversations(req.query.status ? String(req.query.status) : undefined);
    const tickets = getDb().prepare(`SELECT conversation_id, reason_code, priority FROM tickets WHERE status='open'`).all() as any[];
    res.json(list.filter((c) => c.last_message).map((c) => ({
      id: c.id, channel: c.channel, status: c.status, language: c.language, customer: c.customer_name ?? (c.customer_phone ? maskPhone(c.customer_phone) : 'Visitor'),
      phone: c.customer_phone ? maskPhone(c.customer_phone) : null, orderId: c.context_order_id, lastMessage: c.last_message, lastMessageAt: c.last_message_at, mood: c.mood,
      handoverCode: c.handover_code, handoverLabel: c.handover_code ? (HANDOVER_LABELS as any)[c.handover_code] : null, assignedTo: c.assigned_to, verified: c.verified_orders.length > 0,
      priority: tickets.find((t) => t.conversation_id === c.id)?.priority ?? null, flow: c.flow?.type ?? null, createdAt: c.created_at,
    })));
  }));
  d.get('/conversations/:id', wrap(async (req, res) => {
    const c = getConversation(String(req.params.id));
    if (!c) return res.status(404).json({ error: 'not found' });
    const tickets = getDb().prepare('SELECT * FROM tickets WHERE conversation_id=? ORDER BY created_at DESC').all(c.id);
    const orderIds = [...new Set([c.context_order_id, ...c.verified_orders].filter(Boolean))] as string[];
    const llm = getDb().prepare('SELECT COUNT(*) calls, COALESCE(SUM(input_tokens),0) input, COALESCE(SUM(output_tokens),0) output, COALESCE(SUM(cost_usd),0) cost FROM llm_calls WHERE conversation_id=?').get(c.id);
    res.json({
      conversation: { ...c, customer_phone: c.customer_phone ? maskPhone(c.customer_phone) : null, verified_phone: c.verified_phone ? maskPhone(c.verified_phone) : null, candidate_phone: c.candidate_phone ? maskPhone(c.candidate_phone) : null, handoverLabel: c.handover_code ? (HANDOVER_LABELS as any)[c.handover_code] : null },
      messages: getMessages(c.id), toolCalls: getToolCalls(c.id), tickets,
      orders: orderIds.map((id) => getOrder(id)).filter(Boolean).map((o) => ({ id: o!.id, status: o!.status, payment_method: o!.payment_method, total: o!.total, items: o!.items, risk_band: o!.risk_band, cod_confirmation: o!.cod_confirmation, ndr_attempts: o!.ndr_attempts })),
      llm,
    });
  }));
  d.post('/conversations/:id/takeover', wrap(async (req, res) => {
    const agent = String(req.body?.agent ?? 'Support agent').slice(0, 40);
    const c = updateConversation(String(req.params.id), { status: 'human', assigned_to: agent, pending_action: null } as any);
    getDb().prepare(`INSERT INTO messages(id,conversation_id,role,content,meta,created_at) VALUES (?,?,?,?,?,?)`).run(uid('m_'), c.id, 'system', `${agent} took over the chat`, '{}', nowIso());
    res.json({ ok: true, status: c.status });
  }));
  d.post('/conversations/:id/handback', wrap(async (req, res) => {
    const c = updateConversation(String(req.params.id), { status: 'ai', assigned_to: null, unresolved_count: 0, tool_failures: 0, injection_attempts: 0, handover_code: null, handover_reason: null } as any);
    getDb().prepare(`UPDATE tickets SET status='closed', closed_at=? WHERE conversation_id=? AND status='open'`).run(nowIso(), c.id);
    getDb().prepare(`INSERT INTO messages(id,conversation_id,role,content,meta,created_at) VALUES (?,?,?,?,?,?)`).run(uid('m_'), c.id, 'system', 'Chat handed back to the AI assistant', '{}', nowIso());
    res.json({ ok: true, status: c.status });
  }));
  d.post('/conversations/:id/resolve', wrap(async (req, res) => {
    const c = updateConversation(String(req.params.id), { status: 'resolved', resolved_at: nowIso(), pending_action: null } as any);
    getDb().prepare(`UPDATE tickets SET status='closed', closed_at=? WHERE conversation_id=? AND status='open'`).run(nowIso(), c.id);
    res.json({ ok: true, status: c.status });
  }));
  d.post('/conversations/:id/messages', wrap(async (req, res) => {
    const b = z.object({ text: z.string().min(1).max(2000), agent: z.string().max(40).optional() }).safeParse(req.body);
    if (!b.success) return res.status(400).json({ error: b.error.issues });
    const m = await sendHumanMessage(String(req.params.id), b.data.text, b.data.agent ?? 'Support agent');
    res.json({ ok: true, message: m });
  }));

  d.get('/tickets', wrap(async (req, res) => {
    res.json(getDb().prepare(`SELECT * FROM tickets ${req.query.status ? 'WHERE status=?' : ''} ORDER BY created_at DESC LIMIT 200`).all(...(req.query.status ? [String(req.query.status)] : [])));
  }));
  d.patch('/tickets/:id', wrap(async (req, res) => {
    const b = z.object({ status: z.enum(['open', 'closed']).optional(), suggested_reply: z.string().max(2000).optional() }).parse(req.body);
    if (b.status) getDb().prepare('UPDATE tickets SET status=?, closed_at=? WHERE id=?').run(b.status, b.status === 'closed' ? nowIso() : null, String(req.params.id));
    if (b.suggested_reply != null) getDb().prepare('UPDATE tickets SET suggested_reply=? WHERE id=?').run(b.suggested_reply, String(req.params.id));
    res.json({ ok: true });
  }));

  d.get('/orders', wrap(async (req, res) => {
    const f = req.query;
    const list = listOrders({ payment: f.payment as string, status: f.status as string, risk: f.risk as string, confirmation: f.confirmation as string, ndr: f.ndr === '1', q: f.q as string });
    res.json(list.map((o) => ({ ...o, phone: maskPhone(o.phone), email: undefined })));
  }));
  d.get('/orders/:id', wrap(async (req, res) => {
    const o = getOrder(String(req.params.id));
    if (!o) return res.status(404).json({ error: 'not found' });
    let tracking: any = null;
    if (o.awb) { try { tracking = await courier.track(o.awb); } catch (e: any) { tracking = { error: e.message }; } }
    const convs = getDb().prepare(`SELECT id,status,channel,updated_at FROM conversations WHERE context_order_id=? OR verified_orders LIKE ? ORDER BY updated_at DESC`).all(o.id, `%"${o.id}"%`);
    const tickets = getDb().prepare('SELECT * FROM tickets WHERE order_id=? ORDER BY created_at DESC').all(o.id);
    const returns = refundView(o.id);
    res.json({ order: { ...o, phone: maskPhone(o.phone) }, audit: getAudit(o.id), tracking, conversations: convs, tickets, ...returns, trackingUrl: o.awb ? courier.trackingUrl(o.awb) : null });
  }));
  d.post('/orders/:id/actions', wrap(async (req, res) => {
    const b = z.object({ action: z.enum(['resend_confirmation', 'confirm', 'cancel', 'release_hold', 'note']), note: z.string().max(500).optional(), agent: z.string().max(40).optional() }).parse(req.body);
    const id = String(req.params.id);
    const o = getOrder(id);
    if (!o) return res.status(404).json({ error: 'not found' });
    const actor = `human:${b.agent ?? 'ops'}`;
    if (b.action === 'resend_confirmation') {
      if (o.payment_method !== 'cod') return res.status(409).json({ error: 'not a COD order' });
      if (o.cod_confirmation !== 'pending') updateOrder(o.id, { cod_confirmation: 'pending', status: 'pending_confirmation' }, actor, 'confirmation re-sent from dashboard');
      getDb().prepare(`DELETE FROM messages WHERE dedupe_key=?`).run(`cod-confirm:${o.id}`);
      await sendCodConfirmation(o.id);
    }
    if (b.action === 'confirm') confirmCod(o.id, actor, null, 'confirmed by ops');
    if (b.action === 'cancel') cancelOrder(o.id, actor, null, b.note ?? 'cancelled by ops');
    if (b.action === 'release_hold') updateOrder(o.id, { status: 'pending_confirmation', cod_confirmation: 'pending' }, actor, 'hold released');
    if (b.action === 'note' && b.note) addOrderNote(o.id, b.note, actor);
    res.json({ ok: true, order: getOrder(o.id) });
  }));

  // ---- test tooling: create orders through the signed webhook, trigger courier events
  d.post('/test/orders', wrap(async (req, res) => {
    const b = z.object({ preset: z.enum(['low_risk', 'high_risk', 'repeat_refuser', 'prepaid', 'custom']).default('high_risk'), duplicate: z.boolean().optional(), order: z.any().optional() }).parse(req.body ?? {});
    const base = b.preset === 'custom' ? b.order : structuredClone(PRESETS[b.preset]);
    if (!base.customer.phone) base.customer.phone = randomPhone();
    const payload = { id: nextOrderId(), created_at: nowIso(), ...base };
    const out = await postSignedOrderWebhook(payload, { duplicate: b.duplicate });
    res.status(201).json({ orderId: payload.id, webhook: out.first, duplicateResponse: out.second });
  }));
  d.post('/test/courier/:orderId', wrap(async (req, res) => {
    const b = z.object({ status: z.enum(COURIER_STATUSES), reason: z.string().max(200).optional(), duplicate: z.boolean().optional() }).parse(req.body);
    let o = getOrder(String(req.params.orderId));
    if (!o) return res.status(404).json({ error: 'not found' });
    if (!o.awb) {
      if (o.status !== 'confirmed') return res.status(409).json({ error: `Order is ${o.status}; it needs to be confirmed before it can ship.` });
      const s = await courier.createShipment(o.id, { name: o.name, phone: o.phone, address: o.address_line1, pincode: o.pincode });
      o = updateOrder(o.id, { awb: s.awb, courier: 'SwiftShip' }, 'system', 'shipment created');
    }
    const out = await courier.event(o.awb!, b);
    res.json({ ok: true, awb: o.awb, event: (out as any).event });
  }));
  d.post('/test/reset', wrap(async (_req, res) => { const r = seed({ reset: true }); res.json({ ok: true, ...r }); }));
  d.post('/test/run-jobs', wrap(async (_req, res) => { const n = (await getQueue().drain?.({ includeDelayed: true })) ?? 0; res.json({ ok: true, ran: n }); }));

  d.get('/meta', (_req, res) => res.json({ courierStatuses: COURIER_STATUSES, ndrReasons: NDR_REASONS, presets: Object.keys(PRESETS), products: PRODUCTS, handoverLabels: HANDOVER_LABELS }));
  d.get('/settings', (_req, res) => res.json({ settings: getSettings(), defaults: DEFAULT_SETTINGS, fastTimings: FAST_TIMINGS }));
  d.put('/settings', wrap(async (req, res) => {
    try { res.json({ settings: updateSettings(req.body) }); } catch (e: any) { res.status(400).json({ error: e.issues ?? e.message }); }
  }));
  d.get('/analytics', wrap(async (_req, res) => res.json(analytics())));
  d.get('/llm-calls', wrap(async (_req, res) => res.json(getDb().prepare('SELECT * FROM llm_calls ORDER BY id DESC LIMIT 100').all())));
  d.get('/jobs', wrap(async (_req, res) => res.json({ driver: getQueue().driver, stats: await getQueue().stats(), recent: getQueue().driver === 'sqlite' ? getDb().prepare('SELECT id,job_key,type,status,attempts,last_error,run_at,created_at FROM jobs ORDER BY id DESC LIMIT 50').all() : [] })));
  d.get('/webhook-events', wrap(async (_req, res) => res.json(getDb().prepare('SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT 100').all())));

  r.use(d);
  return r;
}

export { json };
