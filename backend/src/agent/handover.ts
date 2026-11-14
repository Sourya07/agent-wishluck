/**
 * Handover to the human support team.
 * Stops the AI on the conversation, creates a ticket with a 2–3 line summary, order context, the customer's mood
 * and an editable suggested reply. The summary comes from the LLM when available (short timeout) and
 * otherwise from a deterministic template — a handover never fails because the model is down.
 */
import { getDb, nowIso } from '../db/index.js';
import { publish } from '../lib/events.js';
import { shortId } from '../lib/ids.js';
import { maskPhone } from '../lib/pii.js';
import { log } from '../lib/logger.js';
import { inr } from '../lib/time.js';
import { getSettings } from '../settings.js';
import { getConversation, getMessages, updateConversation, type Conversation } from '../services/conversations.js';
import { getOrder } from '../services/orders.js';
import { sendToCustomer } from '../services/messaging.js';
import { chat, llmAvailable } from './llm/provider.js';
import { detectMood, type Lang, type Mood } from './nlu.js';
import { t, type Reply } from './templates.js';

export type HandoverCode =
  | 'customer_request' | 'legal_threat' | 'angry_customer' | 'manual_review' | 'goodwill_request' | 'repeated_failure'
  | 'tool_failure' | 'unclear_request' | 'verification_failed' | 'injection_attempts' | 'ndr_no_response' | 'bulk_order' | 'other';

export const HANDOVER_LABELS: Record<HandoverCode, string> = {
  customer_request: 'Asked for a person', legal_threat: 'Legal / public complaint threat', angry_customer: 'Upset customer',
  manual_review: 'Policy: manual review', goodwill_request: 'Goodwill / compensation request', repeated_failure: 'Agent failed twice',
  tool_failure: 'Tool keeps failing', unclear_request: 'Agent unsure what customer wants', verification_failed: 'Repeated verification failure',
  injection_attempts: 'Repeated manipulation attempts', ndr_no_response: 'Failed delivery, no response', bulk_order: 'Bulk / B2B order', other: 'Other',
};

const PRIORITY: Partial<Record<HandoverCode, 'high' | 'normal' | 'low'>> = { legal_threat: 'high', angry_customer: 'high', ndr_no_response: 'high', manual_review: 'normal', tool_failure: 'normal' };

function overallMood(conv: Conversation): Mood {
  const cfg = getSettings().handover;
  const moods = getMessages(conv.id).filter((m) => m.role === 'customer').slice(-4).map((m) => detectMood(m.content, cfg));
  if (moods.includes('angry')) return 'angry';
  if (moods.includes('frustrated')) return 'frustrated';
  if (moods.length && moods[moods.length - 1] === 'positive') return 'positive';
  return 'neutral';
}

function templateSummary(conv: Conversation, code: HandoverCode, reason: string, order: ReturnType<typeof getOrder>, mood: Mood) {
  const msgs = getMessages(conv.id).filter((m) => m.role === 'customer');
  const last = msgs[msgs.length - 1]?.content ?? '';
  const who = conv.customer_name ?? (conv.customer_phone ? `Customer ${maskPhone(conv.customer_phone)}` : 'Unverified customer');
  const topics = [...new Set(conv.intents)].filter((i) => !['greeting', 'thanks', 'provide_details', 'unknown'].includes(i)).map((i) => i.replace(/_/g, ' '));
  const lines = [
    `${who} — ${HANDOVER_LABELS[code]}: ${reason}`,
    order ? `Order ${order.id}: ${order.status.replace(/_/g, ' ')}, ${order.payment_method.toUpperCase()}, ${inr(order.total)} (${order.items.map((i) => `${i.name}${i.size ? ' ' + i.size : ''}`).join(', ')}).${topics.length ? ` Topics: ${topics.join(', ')}.` : ''}` : `No verified order yet.${topics.length ? ` Topics: ${topics.join(', ')}.` : ''}`,
    `Last message (${mood}): "${last.slice(0, 160)}"`,
  ];
  const name = (conv.customer_name ?? '').split(' ')[0] || 'there';
  const oid = order ? ` regarding order ${order.id}` : '';
  const replies: Partial<Record<HandoverCode, string>> = {
    legal_threat: `Hi ${name}, I'm from the Wishluck support team and I've read through your chat${oid}. I'm really sorry this has dragged on. I'm taking ownership of this personally and will get back to you with a resolution within 2 hours.`,
    angry_customer: `Hi ${name}, I'm from the Wishluck support team. I'm sorry for the trouble${oid} — I've gone through the conversation and I'm looking into it right now. I'll update you shortly.`,
    manual_review: `Hi ${name}, I've reviewed your request${oid}. [Approve/decline as per review] — I'll share the next steps here.`,
    goodwill_request: `Hi ${name}, thanks for your patience${oid}. I've looked into what happened and [state the goodwill decision].`,
    ndr_no_response: `Hi ${name}, the courier couldn't deliver order ${order?.id ?? ''} twice. Could you share a good time or an alternate number so we can deliver it? Otherwise it will be returned to us.`,
    customer_request: `Hi ${name}, this is the Wishluck support team. I've read your chat${oid} — how can I help?`,
  };
  return { summary: lines.join('\n'), suggestedReply: replies[code] ?? `Hi ${name}, this is the Wishluck support team. I've gone through your chat${oid} and I'm looking into it now.` };
}

async function llmSummary(conv: Conversation, code: HandoverCode, reason: string, order: ReturnType<typeof getOrder>) {
  const transcript = getMessages(conv.id).slice(-14).map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
  const orderCtx = order ? JSON.stringify({ id: order.id, status: order.status, payment: order.payment_method, total: order.total, items: order.items.map((i) => ({ name: i.name, size: i.size, price: i.price })), ndr_attempts: order.ndr_attempts }) : 'none';
  const r = await chat({
    conversationId: conv.id, purpose: 'handover_summary', json: true, maxTokens: 400, temperature: 0.2,
    messages: [
      { role: 'system', content: 'You write handover notes for an Indian D2C fashion brand support team. Use only facts in the transcript and order JSON. Return JSON: {"summary": "2-3 short lines", "mood": "angry|frustrated|neutral|positive", "suggested_reply": "a warm, specific reply the human agent can edit and send, in the customer\'s language, no promises of refunds or dates"}' },
      { role: 'user', content: `Handover reason: ${HANDOVER_LABELS[code]} — ${reason}\nOrder: ${orderCtx}\nTranscript:\n${transcript}` },
    ],
  });
  const j = JSON.parse((r.content ?? '{}').replace(/^```json\s*|```$/g, ''));
  if (!j.summary || !j.suggested_reply) throw new Error('bad summary json');
  return { summary: String(j.summary), suggestedReply: String(j.suggested_reply), mood: j.mood as Mood | undefined };
}

export async function handover(conversationId: string, p: { code: HandoverCode; reason: string; orderId?: string | null; notify?: boolean; lang?: Lang }): Promise<{ reply: Reply; ticketId: string | null }> {
  const conv = getConversation(conversationId)!;
  const lang = (p.lang ?? conv.language) as Lang;
  const reply: Reply = { text: t(lang, 'handover') };
  if (conv.status === 'needs_human' || conv.status === 'human') return { reply: { text: t(lang, 'handover_paused') }, ticketId: null };

  const orderId = p.orderId ?? conv.context_order_id ?? conv.verified_orders[conv.verified_orders.length - 1] ?? null;
  const order = orderId ? getOrder(orderId) : null;
  let mood = overallMood(conv);
  if (p.code === 'legal_threat' || p.code === 'angry_customer') mood = 'angry';
  let s = templateSummary(conv, p.code, p.reason, order, mood);
  if (llmAvailable()) {
    try {
      const l = await llmSummary(conv, p.code, p.reason, order);
      s = { summary: l.summary, suggestedReply: l.suggestedReply };
      if (l.mood && p.code !== 'legal_threat') mood = l.mood;
    } catch (e: any) { log.warn('handover summary fell back to template', { error: e.message }); }
  }
  const id = shortId('TKT-');
  getDb().prepare(`INSERT INTO tickets(id,conversation_id,order_id,reason_code,reason,summary,mood,suggested_reply,priority,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, conv.id, order?.id ?? null, p.code, p.reason, s.summary, mood, s.suggestedReply, PRIORITY[p.code] ?? 'normal', 'open', nowIso());
  updateConversation(conv.id, { status: 'needs_human', handover_code: p.code, handover_reason: p.reason, mood, handed_over_ever: 1, pending_action: null } as any);
  publish({ type: 'ticket.created', ticketId: id, conversationId: conv.id });
  if (p.notify) await sendToCustomer(conv.id, reply, { meta: { handover: { code: p.code, reason: p.reason, ticketId: id } } });
  log.info('handover', { conversationId: conv.id, code: p.code, ticket: id });
  return { reply, ticketId: id };
}

/** A callback request: creates a ticket but the AI keeps handling the chat. */
export function createCallbackTicket(conversationId: string, reason: string, orderId?: string | null) {
  const conv = getConversation(conversationId)!;
  const existing = getDb().prepare(`SELECT id FROM tickets WHERE conversation_id=? AND reason_code='callback' AND status='open'`).get(conv.id) as any;
  if (existing) return existing.id as string;
  const id = shortId('TKT-');
  const who = conv.customer_name ?? (conv.customer_phone ? maskPhone(conv.customer_phone) : 'unverified customer');
  getDb().prepare(`INSERT INTO tickets(id,conversation_id,order_id,reason_code,reason,summary,mood,suggested_reply,priority,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, conv.id, orderId ?? null, 'callback', reason, `Callback requested by ${who}. ${reason}`, overallMood(conv), 'Call the customer on the registered number.', 'normal', 'open', nowIso());
  publish({ type: 'ticket.created', ticketId: id, conversationId: conv.id });
  return id;
}
