/**
 * Executors for actions that change an order. They run ONLY after the customer explicitly said yes
 * to the exact summary we showed (stored as conversation.pending_action). Policy is re-checked at
 * execution time, so a stale confirmation can never bypass the rules.
 */
import { evaluateAddressChange, evaluateCancellation, evaluateExchange, evaluateReturn } from '../policy/policy.js';
import { productBySku } from '../policy/catalog.js';
import { getOrder, getStock, pincodeInfo, returnsLast60Days, updateOrder, computeRisk } from '../services/orders.js';
import { activeRequestForItem, createReturnRecord } from '../services/returns.js';
import { cancelOrder, codButtons } from '../services/cod.js';
import { ndrApply, rtoRefundIfRefused } from '../services/ndr.js';
import { updateConversation, type Conversation, type PendingAction } from '../services/conversations.js';
import { getSettings } from '../settings.js';
import { handover } from './handover.js';
import { t, type Reply } from './templates.js';
import type { Lang } from './nlu.js';

export interface ActionResult { reply: Reply; ok: boolean; facts: Record<string, any> }

export async function executePending(conv: Conversation, a: PendingAction, lang: Lang): Promise<ActionResult> {
  updateConversation(conv.id, { pending_action: null } as any);
  const p = a.params;
  const order = getOrder(p.orderId);
  if (!order) return { ok: false, reply: { text: t(lang, 'clarify') }, facts: {} };
  const actor = 'agent';

  switch (a.type) {
    case 'cancel_order':
    case 'cod_cancel': {
      const d = evaluateCancellation(order);
      if (!d.allowed) return { ok: false, reply: { text: t(lang, 'cancel_other', { orderId: order.id, reason: d.reasons.join(' ') }) }, facts: { decision: d } };
      cancelOrder(order.id, actor, conv.id, p.reason ?? 'customer requested cancellation');
      const text = a.type === 'cod_cancel' ? t(lang, 'cod_cancelled', { orderId: order.id }) : t(lang, 'cancel_done', { orderId: order.id, refundNote: d.refundTimeline });
      return { ok: true, reply: { text }, facts: { cancelled: order.id, decision: d } };
    }
    case 'change_address': {
      const pin = pincodeInfo(p.pincode);
      const d = evaluateAddressChange(order, pin);
      if (!d.allowed) return { ok: false, reply: { text: t(lang, 'address_rejected', { reason: d.reasons.join(' ') }) }, facts: { decision: d } };
      const updated = updateOrder(order.id, { address_line1: p.address_line1, address_line2: null, landmark: p.landmark ?? null, city: p.city ?? pin?.city ?? order.city, state: pin?.state ?? order.state, pincode: p.pincode }, actor, 'customer changed delivery address', conv.id);
      if (updated.payment_method === 'cod' && updated.cod_confirmation !== 'not_required') {
        const r = computeRisk(updated);
        updateOrder(updated.id, { risk_score: r.score, risk_band: r.band, risk_reasons: r.reasons }, 'system', 'risk re-scored after address change');
      }
      if (updated.cod_confirmation === 'pending' || updated.cod_confirmation === 'on_hold') {
        updateConversation(conv.id, { flow: { type: 'cod_confirm', orderId: order.id } } as any);
        return { ok: true, reply: { text: `${t(lang, 'address_done', { orderId: order.id })} ${t(lang, 'cod_reminder', { orderId: order.id, total: updated.total })}`, buttons: codButtons(lang, order.id) }, facts: { updated: true } };
      }
      return { ok: true, reply: { text: t(lang, 'address_done', { orderId: order.id }) }, facts: { updated: true } };
    }
    case 'create_return': {
      const item = order.items.find((i) => i.id === p.itemId)!;
      const product = productBySku(item.sku)!;
      const d = evaluateReturn({ order, item, product, returnsLast60Days: returnsLast60Days(order.phone), hasActiveRequest: activeRequestForItem(item.id), isDamageClaim: p.damageClaim, hasPhoto: p.hasPhoto, refundLimit: getSettings().handover.refundLimit });
      if (!d.allowed) return { ok: false, reply: { text: t(lang, 'return_rejected', { item: item.name, reason: d.reasons.join(' '), exchange: d.alternatives.includes('size_exchange') }) }, facts: { decision: d } };
      const rec = createReturnRecord({ order, item, type: 'return', reason: p.reason, status: d.outcome === 'manual_review' ? 'manual_review' : 'approved', refundAmount: d.refundAmount, refundMethod: p.refundMethod, actor, conversationId: conv.id });
      if (d.outcome === 'manual_review') {
        const h = await handover(conv.id, { code: 'manual_review', reason: `Return ${rec.id} needs manual review: ${(d.manualReviewReasons ?? []).join(' ')}`, orderId: order.id, lang });
        return { ok: true, reply: h.reply, facts: { return_id: rec.id, decision: d } };
      }
      return { ok: true, reply: { text: t(lang, 'return_done', { returnId: rec.id, timeline: d.refundTimeline }) }, facts: { return_id: rec.id, decision: d } };
    }
    case 'create_exchange': {
      const item = order.items.find((i) => i.id === p.itemId)!;
      const product = productBySku(item.sku)!;
      const d = evaluateExchange({ order, item, product, newSize: p.newSize, stockQty: getStock(item.sku, p.newSize), returnsLast60Days: returnsLast60Days(order.phone), hasActiveRequest: activeRequestForItem(item.id) });
      if (!d.allowed) return { ok: false, reply: { text: t(lang, 'exchange_rejected', { reason: d.reasons.join(' ') }) }, facts: { decision: d } };
      const rec = createReturnRecord({ order, item, type: 'exchange', reason: p.reason, newSize: p.newSize, status: d.outcome === 'manual_review' ? 'manual_review' : 'approved', actor, conversationId: conv.id });
      if (d.outcome === 'manual_review') {
        const h = await handover(conv.id, { code: 'manual_review', reason: `Exchange ${rec.id} needs manual review: ${(d.manualReviewReasons ?? []).join(' ')}`, orderId: order.id, lang });
        return { ok: true, reply: h.reply, facts: { return_id: rec.id } };
      }
      return { ok: true, reply: { text: t(lang, 'exchange_done', { returnId: rec.id, from: item.size, to: p.newSize }) }, facts: { exchange_id: rec.id } };
    }
    case 'ndr_address': {
      await ndrApply(order.id, 'update_address', { address: p.address, landmark: p.landmark, pincode: p.pincode }, actor, conv.id);
      return { ok: true, reply: { text: t(lang, 'ndr_address_done', { orderId: order.id }) }, facts: { ndr: 'address_updated' } };
    }
    case 'ndr_rto': {
      await ndrApply(order.id, 'rto', { reason: p.reason }, actor, conv.id);
      return { ok: true, reply: { text: t(lang, 'ndr_rto_done', { orderId: order.id, prepaid: order.payment_method === 'prepaid', refund: rtoRefundIfRefused(order.total) }) }, facts: { ndr: 'rto' } };
    }
  }
  return { ok: false, reply: { text: t(lang, 'clarify') }, facts: {} };
}
