import { getDb, json, nowIso } from '../db/index.js';
import { publish } from '../lib/events.js';
import { inferPincode, productBySku, type PincodeInfo } from '../policy/catalog.js';
import { etaWindow, evaluateCod, shippingFee, POLICY } from '../policy/policy.js';
import { scoreCodRisk } from '../risk/riskScore.js';
import { getSettings } from '../settings.js';
import { normalizePhone } from '../lib/pii.js';
import { uid } from '../lib/ids.js';

export interface OrderItem { id: string; order_id: string; sku: string; name: string; size: string | null; qty: number; price: number; exchange_count: number }
export interface Order {
  id: string; customer_id: string | null; name: string; phone: string; email: string | null;
  address_line1: string | null; address_line2: string | null; landmark: string | null; city: string | null; state: string | null; pincode: string | null;
  payment_method: 'cod' | 'prepaid'; status: string; subtotal: number; shipping_fee: number; cod_fee: number; discount: number; total: number;
  cod_confirmation: string; confirmation_sent_at: string | null; reminder_sent_at: string | null; confirmed_at: string | null;
  risk_score: number | null; risk_band: string | null; risk_reasons: any[];
  awb: string | null; courier: string | null; eta_from: string | null; eta_to: string | null;
  ndr_attempts: number; ndr_status: string | null; ndr_reason: string | null; ndr_contacted_at: string | null; ndr_resolution: string | null;
  rto_reason: string | null; cancel_reason: string | null; notes: { at: string; by: string; text: string }[]; source: string;
  created_at: string; shipped_at: string | null; delivered_at: string | null; updated_at: string;
  items: OrderItem[];
}

const db = () => getDb();

function hydrate(row: any): Order | null {
  if (!row) return null;
  const items = db().prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY id').all(row.id) as OrderItem[];
  return { ...row, risk_reasons: json(row.risk_reasons, []), notes: json(row.notes, []), items };
}

export const getOrder = (id: string): Order | null =>
  hydrate(db().prepare('SELECT * FROM orders WHERE id=?').get(String(id).toUpperCase().replace(/^#/, '')));

export const getOrderByAwb = (awb: string): Order | null => hydrate(db().prepare('SELECT * FROM orders WHERE awb=?').get(awb));

export function listOrders(f: { payment?: string; status?: string; risk?: string; confirmation?: string; ndr?: boolean; q?: string; limit?: number } = {}) {
  const where: string[] = [];
  const args: any[] = [];
  if (f.payment) { where.push('payment_method=?'); args.push(f.payment); }
  if (f.status) { where.push('status=?'); args.push(f.status); }
  if (f.risk) { where.push('risk_band=?'); args.push(f.risk); }
  if (f.confirmation) { where.push('cod_confirmation=?'); args.push(f.confirmation); }
  if (f.ndr) where.push('ndr_attempts>0');
  if (f.q) { where.push('(id LIKE ? OR name LIKE ? OR awb LIKE ?)'); args.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`); }
  const rows = db().prepare(`SELECT * FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`).all(...args, f.limit ?? 300);
  return rows.map(hydrate) as Order[];
}

export function recordAudit(entityType: string, entityId: string, field: string, oldV: unknown, newV: unknown, actor: string, reason?: string, conversationId?: string | null) {
  const s = (v: unknown) => (v === undefined || v === null ? null : typeof v === 'string' ? v : JSON.stringify(v));
  db().prepare(`INSERT INTO audit_log(entity_type,entity_id,field,old_value,new_value,actor,reason,conversation_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(entityType, entityId, field, s(oldV), s(newV), actor, reason ?? null, conversationId ?? null, nowIso());
}

const UPDATABLE = new Set([
  'status', 'payment_method', 'address_line1', 'address_line2', 'landmark', 'city', 'state', 'pincode', 'phone', 'subtotal', 'shipping_fee', 'cod_fee', 'discount', 'total',
  'cod_confirmation', 'confirmation_sent_at', 'reminder_sent_at', 'confirmed_at', 'risk_score', 'risk_band', 'risk_reasons', 'awb', 'courier', 'eta_from', 'eta_to',
  'ndr_attempts', 'ndr_status', 'ndr_reason', 'ndr_contacted_at', 'ndr_resolution', 'rto_reason', 'cancel_reason', 'shipped_at', 'delivered_at',
]);
/** Fields whose changes are not interesting enough for the audit trail. */
const NO_AUDIT = new Set(['confirmation_sent_at', 'reminder_sent_at', 'ndr_contacted_at', 'risk_reasons']);

/**
 * The only way to mutate an order. Every changed field is written to the audit log with old/new values and the actor.
 */
export function updateOrder(id: string, patch: Partial<Record<string, any>>, actor: string, reason?: string, conversationId?: string | null): Order {
  const cur = getOrder(id);
  if (!cur) throw new Error(`Order ${id} not found`);
  const sets: string[] = [];
  const args: any[] = [];
  const tx = db().transaction(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (!UPDATABLE.has(k)) throw new Error(`Field ${k} is not updatable`);
      const old = (cur as any)[k];
      const nv = k === 'risk_reasons' ? JSON.stringify(v) : v;
      const oldCmp = k === 'risk_reasons' ? JSON.stringify(old) : old;
      if (oldCmp === nv) continue;
      sets.push(`${k}=?`); args.push(nv);
      if (!NO_AUDIT.has(k)) recordAudit('order', cur.id, k, old, v, actor, reason, conversationId);
    }
    if (sets.length) {
      sets.push('updated_at=?'); args.push(nowIso());
      db().prepare(`UPDATE orders SET ${sets.join(',')} WHERE id=?`).run(...args, cur.id);
    }
  });
  tx();
  if (sets.length) publish({ type: 'order.updated', orderId: cur.id });
  return getOrder(cur.id)!;
}

export function addOrderNote(id: string, text: string, by: string) {
  const o = getOrder(id);
  if (!o) return;
  const notes = [...o.notes, { at: nowIso(), by, text }];
  db().prepare('UPDATE orders SET notes=?, updated_at=? WHERE id=?').run(JSON.stringify(notes), nowIso(), o.id);
  recordAudit('order', o.id, 'note', null, text, by);
  publish({ type: 'order.updated', orderId: o.id });
}

export function getAudit(entityId: string) {
  return db().prepare('SELECT * FROM audit_log WHERE entity_id=? ORDER BY id DESC').all(entityId);
}

export function pincodeInfo(pin?: string | null): PincodeInfo | null {
  if (!pin) return null;
  const p = String(pin).trim();
  const row = db().prepare('SELECT * FROM pincodes WHERE pincode=?').get(p) as any;
  if (row) return { pincode: row.pincode, city: row.city, state: row.state, zone: row.zone, serviceable: !!row.serviceable, cod: !!row.cod, rtoRate: row.rto_rate, known: true };
  return inferPincode(p);
}

export function getStock(sku: string, size: string) {
  const r = db().prepare('SELECT qty FROM inventory WHERE sku=? AND size=?').get(sku.toUpperCase(), String(size).toUpperCase()) as { qty: number } | undefined;
  return r?.qty ?? 0;
}
export function adjustStock(sku: string, size: string, delta: number, actor: string, reason: string) {
  const before = getStock(sku, size);
  db().prepare('UPDATE inventory SET qty=MAX(0, qty+?) WHERE sku=? AND size=?').run(delta, sku, size);
  recordAudit('inventory', `${sku}:${size}`, 'qty', before, before + delta, actor, reason);
}

export function customerHistory(phone: string, excludeOrderId?: string) {
  const p = normalizePhone(phone);
  const rows = db().prepare('SELECT id,status,payment_method,created_at FROM orders WHERE phone=?').all(p) as any[];
  const others = rows.filter((r) => r.id !== excludeOrderId);
  const dayAgo = Date.now() - 86_400_000;
  return {
    deliveredOrders: others.filter((r) => r.status === 'delivered').length,
    rtoCount: others.filter((r) => r.status === 'rto_initiated' || r.status === 'rto_delivered').length,
    codOrdersLast24h: others.filter((r) => r.payment_method === 'cod' && new Date(r.created_at).getTime() > dayAgo).length,
    totalOrders: others.length,
  };
}

export function returnsLast60Days(phone: string) {
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const r = db().prepare(`SELECT COUNT(*) c FROM returns WHERE phone=? AND created_at>=? AND status!='rejected'`).get(normalizePhone(phone), since) as { c: number };
  return r.c;
}

export function computeRisk(o: Pick<Order, 'id' | 'total' | 'address_line1' | 'address_line2' | 'landmark' | 'city' | 'pincode' | 'phone' | 'name' | 'email' | 'created_at'>) {
  const pin = pincodeInfo(o.pincode);
  const r = scoreCodRisk({
    total: o.total,
    address: { line1: o.address_line1, line2: o.address_line2, landmark: o.landmark, city: o.city },
    pincode: pin, phone: o.phone, name: o.name, email: o.email, createdAt: o.created_at,
    history: customerHistory(o.phone, o.id),
  }, getSettings().risk);
  const cod = evaluateCod(o.total, pin);
  if (!cod.allowed) r.reasons.unshift({ signal: 'cod_not_allowed', points: 0, detail: `COD policy check failed: ${cod.reasons.join(' ')}` });
  return { ...r, codAllowed: cod.allowed };
}

export interface NewOrderInput {
  id: string; name: string; phone: string; email?: string | null;
  address_line1: string; address_line2?: string | null; landmark?: string | null; city?: string | null; state?: string | null; pincode: string;
  payment_method: 'cod' | 'prepaid';
  items: { sku: string; size?: string | null; qty: number; price?: number }[];
  total?: number; created_at?: string; source?: string;
}

/** Normalises an incoming order (webhook, dashboard, seed) and stores it. Idempotent on order id. */
export function insertOrder(input: NewOrderInput, extra: Partial<Record<string, any>> = {}): { order: Order; created: boolean } {
  const id = input.id.toUpperCase().replace(/^#/, '');
  const existing = getOrder(id);
  if (existing) return { order: existing, created: false };
  const phone = normalizePhone(input.phone);
  const items = input.items.map((i) => {
    const p = productBySku(i.sku);
    return { sku: i.sku.toUpperCase(), name: p?.name ?? i.sku, size: i.size ? String(i.size).toUpperCase() : null, qty: i.qty, price: i.price ?? p?.price ?? 0 };
  });
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const ship = shippingFee(subtotal);
  const codFee = input.payment_method === 'cod' ? POLICY.cod.fee : 0;
  const total = input.total ?? subtotal + ship + codFee;
  const created_at = input.created_at ?? nowIso();
  const pin = pincodeInfo(input.pincode);
  const eta = etaWindow(pin?.zone ?? 'roi', created_at);
  const cust = db().prepare('SELECT id FROM customers WHERE phone=?').get(phone) as { id: string } | undefined;
  const customerId = cust?.id ?? uid('cus_');
  if (!cust) db().prepare('INSERT INTO customers(id,name,phone,email,created_at) VALUES (?,?,?,?,?)').run(customerId, input.name, phone, input.email ?? null, created_at);

  const row: Record<string, any> = {
    id, customer_id: customerId, name: input.name, phone, email: input.email ?? null,
    address_line1: input.address_line1, address_line2: input.address_line2 ?? null, landmark: input.landmark ?? null,
    city: input.city ?? pin?.city ?? null, state: input.state ?? pin?.state ?? null, pincode: input.pincode,
    payment_method: input.payment_method, status: input.payment_method === 'cod' ? 'pending_confirmation' : 'confirmed',
    subtotal, shipping_fee: ship, cod_fee: codFee, discount: 0, total,
    cod_confirmation: input.payment_method === 'cod' ? 'pending' : 'not_required',
    eta_from: eta.from, eta_to: eta.to, source: input.source ?? 'webhook', created_at, updated_at: created_at, notes: '[]',
    ...extra,
  };
  const cols = Object.keys(row);
  db().transaction(() => {
    db().prepare(`INSERT INTO orders(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
    const ins = db().prepare('INSERT INTO order_items(id,order_id,sku,name,size,qty,price,exchange_count) VALUES (?,?,?,?,?,?,?,0)');
    items.forEach((it, idx) => ins.run(`${id}-${idx + 1}`, id, it.sku, it.name, it.size, it.qty, it.price));
  })();
  recordAudit('order', id, 'created', null, { status: row.status, payment: row.payment_method, total }, 'system', `order received via ${row.source}`);
  publish({ type: 'order.updated', orderId: id });
  return { order: getOrder(id)!, created: true };
}

export function ordersForPhone(phone: string) {
  return (db().prepare('SELECT id FROM orders WHERE phone=? ORDER BY created_at DESC').all(normalizePhone(phone)) as { id: string }[]).map((r) => getOrder(r.id)!);
}
