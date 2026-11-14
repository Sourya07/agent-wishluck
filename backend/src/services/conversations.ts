import { getDb, json, nowIso } from '../db/index.js';
import { publish } from '../lib/events.js';
import { uid } from '../lib/ids.js';
import { normalizePhone } from '../lib/pii.js';

export type ConvStatus = 'ai' | 'needs_human' | 'human' | 'resolved';
export interface PendingAction { type: string; params: Record<string, any>; summary: string; created_at: string; orderId?: string }
export interface Flow { type: 'cod_confirm' | 'ndr' | 'awaiting_address' | 'awaiting_phone' | 'awaiting_rto_reason' | 'awaiting_ndr_date' | 'awaiting_refund_method'; orderId: string; purpose?: 'cod' | 'ndr' | 'prepaid' ; data?: Record<string, any> }

export interface Conversation {
  id: string; channel: string; customer_phone: string | null; customer_name: string | null; status: ConvStatus; language: string;
  verified_phone: string | null; verified_orders: string[]; verify_attempts: number; candidate_order_id: string | null; candidate_phone: string | null; pending_intent: { intent: string; text: string } | null;
  pending_action: PendingAction | null; flow: Flow | null; context_order_id: string | null;
  handover_reason: string | null; handover_code: string | null; assigned_to: string | null; mood: string | null;
  injection_attempts: number; tool_failures: number; unresolved_count: number; intents: string[];
  first_customer_at: string | null; first_response_ms: number | null; handed_over_ever: number;
  last_message: string | null; last_message_at: string | null; created_at: string; updated_at: string; resolved_at: string | null;
}

export interface Message { id: string; conversation_id: string; role: 'customer' | 'agent' | 'human' | 'system'; content: string; meta: any; created_at: string }

const db = () => getDb();
const hydrate = (r: any): Conversation | null => r ? ({
  ...r, verified_orders: json(r.verified_orders, []), pending_action: json(r.pending_action, null), flow: json(r.flow, null), pending_intent: json(r.pending_intent, null), intents: json(r.intents, []),
}) : null;

export const getConversation = (id: string) => hydrate(db().prepare('SELECT * FROM conversations WHERE id=?').get(id));

export function createConversation(init: Partial<Conversation> = {}): Conversation {
  const id = init.id ?? uid('c_');
  const now = nowIso();
  db().prepare(`INSERT INTO conversations(id,channel,customer_phone,customer_name,status,language,verified_phone,verified_orders,context_order_id,flow,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, init.channel ?? 'web', init.customer_phone ? normalizePhone(init.customer_phone) : null, init.customer_name ?? null, init.status ?? 'ai', init.language ?? 'en',
    init.verified_phone ?? null, JSON.stringify(init.verified_orders ?? []), init.context_order_id ?? null, init.flow ? JSON.stringify(init.flow) : null, now, now);
  publish({ type: 'conversation.updated', conversationId: id });
  return getConversation(id)!;
}

const JSON_FIELDS = new Set(['verified_orders', 'pending_action', 'flow', 'intents', 'pending_intent']);
export function updateConversation(id: string, patch: Partial<Conversation>) {
  const keys = Object.keys(patch);
  if (!keys.length) return getConversation(id)!;
  const vals = keys.map((k) => (JSON_FIELDS.has(k) ? ((patch as any)[k] == null ? null : JSON.stringify((patch as any)[k])) : (patch as any)[k]));
  db().prepare(`UPDATE conversations SET ${keys.map((k) => `${k}=?`).join(',')}, updated_at=? WHERE id=?`).run(...vals, nowIso(), id);
  publish({ type: 'conversation.updated', conversationId: id });
  return getConversation(id)!;
}

/** Most recent non-resolved conversation for a phone on a channel, or a new one. Used for proactive outreach. */
export function findOrCreateForPhone(phone: string, channel = 'web', name?: string) {
  const p = normalizePhone(phone);
  const r = db().prepare(`SELECT * FROM conversations WHERE customer_phone=? AND channel=? AND status!='resolved' ORDER BY updated_at DESC LIMIT 1`).get(p, channel);
  if (r) return hydrate(r)!;
  return createConversation({ channel, customer_phone: p, customer_name: name ?? null });
}

export function addMessage(conversationId: string, role: Message['role'], content: string, meta: any = {}, dedupeKey?: string): Message | null {
  const id = uid('m_');
  const now = nowIso();
  const r = db().prepare('INSERT OR IGNORE INTO messages(id,conversation_id,role,content,meta,dedupe_key,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, conversationId, role, content, JSON.stringify(meta ?? {}), dedupeKey ?? null, now);
  if (r.changes === 0) return null; // duplicate
  const conv = getConversation(conversationId)!;
  const patch: any = { last_message: content.slice(0, 160), last_message_at: now };
  if (role === 'customer' && !conv.first_customer_at) patch.first_customer_at = now;
  if ((role === 'agent' || role === 'human') && conv.first_customer_at && conv.first_response_ms == null) {
    patch.first_response_ms = Date.now() - new Date(conv.first_customer_at).getTime();
  }
  updateConversation(conversationId, patch);
  const msg: Message = { id, conversation_id: conversationId, role, content, meta, created_at: now };
  publish({ type: 'message.created', conversationId, message: msg });
  return msg;
}

export const getMessages = (conversationId: string): Message[] =>
  (db().prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at, rowid').all(conversationId) as any[]).map((m) => ({ ...m, meta: json(m.meta, {}) }));

export function listConversations(status?: string) {
  const rows = status
    ? db().prepare('SELECT * FROM conversations WHERE status=? ORDER BY COALESCE(last_message_at, updated_at) DESC LIMIT 300').all(status)
    : db().prepare('SELECT * FROM conversations ORDER BY COALESCE(last_message_at, updated_at) DESC LIMIT 300').all();
  return rows.map(hydrate) as Conversation[];
}

export const getToolCalls = (conversationId: string) =>
  (db().prepare('SELECT * FROM tool_calls WHERE conversation_id=? ORDER BY created_at, rowid').all(conversationId) as any[])
    .map((t) => ({ ...t, input: json(t.input, {}), output: json(t.output, null), ok: !!t.ok }));
