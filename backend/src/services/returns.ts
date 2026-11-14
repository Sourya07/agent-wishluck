import { getDb, nowIso } from '../db/index.js';
import { shortId } from '../lib/ids.js';
import { refundWindow, POLICY } from '../policy/policy.js';
import { adjustStock, recordAudit, type Order, type OrderItem } from './orders.js';
import { fmtDate } from '../lib/time.js';

const db = () => getDb();

export function activeRequestForItem(itemId: string) {
  return !!db().prepare(`SELECT 1 FROM returns WHERE item_id=? AND status IN ('requested','manual_review','approved')`).get(itemId);
}

export function createReturnRecord(p: {
  order: Order; item: OrderItem; type: 'return' | 'exchange'; reason?: string; newSize?: string; status: 'approved' | 'manual_review';
  refundAmount?: number; refundMethod?: string | null; actor: string; conversationId?: string | null;
}) {
  const id = shortId(p.type === 'return' ? 'RET-' : 'EXC-');
  const dedupe = `${p.type}:${p.item.id}:${p.status === 'manual_review' ? 'mr' : 'ok'}`;
  const ins = db().prepare(`INSERT OR IGNORE INTO returns(id,order_id,item_id,phone,type,reason,new_size,status,refund_amount,refund_method,dedupe_key,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, p.order.id, p.item.id, p.order.phone, p.type, p.reason ?? null, p.newSize ?? null, p.status, p.refundAmount ?? 0, p.refundMethod ?? null, dedupe, p.actor, nowIso());
  if (ins.changes === 0) {
    const existing = db().prepare('SELECT id FROM returns WHERE dedupe_key=?').get(dedupe) as { id: string };
    return { id: existing.id, duplicate: true };
  }
  recordAudit('order', p.order.id, `${p.type}_request`, null, { id, item: p.item.sku, size: p.item.size, new_size: p.newSize, status: p.status, refund: p.refundAmount }, p.actor, p.reason, p.conversationId);
  if (p.type === 'exchange' && p.status === 'approved' && p.newSize) {
    db().prepare('UPDATE order_items SET exchange_count=exchange_count+1 WHERE id=?').run(p.item.id);
    adjustStock(p.item.sku, p.newSize, -1, p.actor, `reserved for exchange ${id}`);
  }
  if (p.type === 'return' && p.status === 'approved') {
    db().prepare(`INSERT INTO refunds(id,order_id,return_id,amount,method,status,initiated_at) VALUES (?,?,?,?,?,?,?)`)
      .run(shortId('RFD-'), p.order.id, id, p.refundAmount ?? 0, p.refundMethod ?? 'original_payment_method', 'awaiting_qc', nowIso());
  }
  return { id, duplicate: false };
}

const METHOD_LABEL: Record<string, string> = { original_payment_method: 'the original payment method', bank_transfer: 'bank transfer', store_credit: 'store credit' };
const STATUS_LABEL: Record<string, string> = {
  awaiting_qc: 'waiting for the returned item to reach us and pass quality check',
  pending: 'approved after quality check and being processed',
  processed: 'processed',
};

export function refundView(orderId: string) {
  const refunds = (db().prepare('SELECT * FROM refunds WHERE order_id=? ORDER BY initiated_at DESC').all(orderId) as any[]).map((r) => {
    const win = r.qc_passed_at ? refundWindow(r.qc_passed_at) : null;
    return {
      refund_id: r.id, amount: r.amount, method: r.method, method_label: METHOD_LABEL[r.method] ?? r.method, status: r.status, status_label: STATUS_LABEL[r.status] ?? r.status,
      initiated_on: r.initiated_at, qc_passed_on: r.qc_passed_at, processed_on: r.processed_at, reference: r.reference,
      expected_between: win ? { from: win.from, to: win.to } : null,
      expected_text: r.status === 'processed' ? '' : win
        ? `As per policy it should reach ${METHOD_LABEL[r.method] ?? r.method} between ${fmtDate(win.from)} and ${fmtDate(win.to)} (${POLICY.refundWorkingDays[0]}-${POLICY.refundWorkingDays[1]} working days after quality check).`
        : `Refunds are processed ${POLICY.refundWorkingDays[0]}-${POLICY.refundWorkingDays[1]} working days after the item passes quality check.`,
    };
  });
  const returns = (db().prepare('SELECT id,type,status,new_size,refund_amount,created_at FROM returns WHERE order_id=? ORDER BY created_at DESC').all(orderId) as any[]);
  return { refunds, returns };
}
