/**
 * Conversation engine — one entry point for every inbound customer message (web chat + WhatsApp).
 *
 *   save message (idempotent) → paused if a human owns the chat
 *   → button payloads (COD / NDR / confirmations)            [deterministic]
 *   → safety guards: prompt injection, other-customer data, handover triggers   [deterministic, before any LLM]
 *   → pending confirmation yes/no → execute action             [deterministic, policy re-checked]
 *   → awaiting-input flows (new address, alternate phone, refund method …)
 *   → code-level verification (order id + phone)
 *   → agent: LLM with tools (→ grounding check) or rule-based fallback
 *   → post rules: tool failures / unresolved turns → handover
 */
import { getSettings } from '../settings.js';
import { uid } from '../lib/ids.js';
import { log } from '../lib/logger.js';
import { POLICY_TEXT } from '../policy/policyDoc.js';
import { addMessage, getConversation, getMessages, getToolCalls, updateConversation, type Conversation } from '../services/conversations.js';
import { sendToCustomer } from '../services/messaging.js';
import { getOrder } from '../services/orders.js';
import { ndrDateButtons } from '../services/ndr.js';
import { executePending } from './actions.js';
import { buildCorpus, stripClaims, ungrounded } from './grounding.js';
import { handover, type HandoverCode } from './handover.js';
import { chat, llmAvailable, type ChatMsg } from './llm/provider.js';
import { classifyIntent, detectDataLeak, detectHandoverTrigger, detectInjection, detectLanguage, extractEntities, isAffirmative, isNegative, type Entities, type Intent, type Lang } from './nlu.js';
import { stateBlock, systemPrompt } from './prompt.js';
import { proposeAddress, ruleAgent } from './ruleAgent.js';
import { t, type Reply } from './templates.js';
import { runTool, toolSpecs, type TurnCtx } from './tools.js';
import { config } from '../config.js';
import { getDb, nowIso } from '../db/index.js';
import { maskDeep } from '../lib/pii.js';

export type Mode = 'llm' | 'rules' | 'flow' | 'guard' | 'verification';
export interface TurnResult {
  duplicate?: boolean; paused?: boolean; reply: Reply | null; mode?: Mode; intent?: Intent; latencyMs?: number;
  toolCalls?: { name: string; input: any; output: any; ok: boolean }[]; handover?: { code: string; reason: string; ticketId: string | null } | null;
  grounding?: { checked: boolean; violations: string[]; rewritten: boolean; stripped: boolean } | null; messageId?: string; llmFallback?: boolean;
}

const refresh = (ctx: TurnCtx) => { ctx.conv = getConversation(ctx.conv.id)!; };

export async function handleCustomerMessage(conversationId: string, text: string, opts: { payload?: string; clientMessageId?: string } = {}): Promise<TurnResult> {
  const started = Date.now();
  let conv = getConversation(conversationId);
  if (!conv) throw Object.assign(new Error('Conversation not found'), { status: 404 });
  const content = String(text ?? '').slice(0, 2000).trim() || (opts.payload ? opts.payload : '');
  const saved = addMessage(conv.id, 'customer', content, opts.payload ? { payload: opts.payload } : {}, opts.clientMessageId ? `cm:${conv.id}:${opts.clientMessageId}` : undefined);
  if (!saved) return { duplicate: true, reply: null };
  if (conv.status === 'needs_human' || conv.status === 'human') return { paused: true, reply: null };

  const lang = opts.payload ? (conv.language as Lang) : detectLanguage(content, conv.language as Lang);
  const ents = extractEntities(content);
  const intent = opts.payload ? 'provide_details' : classifyIntent(content, ents);
  const patch: any = { language: lang };
  if (conv.status === 'resolved') patch.status = 'ai';
  if (!opts.payload && !['provide_details', 'unknown'].includes(intent)) patch.intents = [...conv.intents, intent].slice(-30);
  conv = updateConversation(conv.id, patch);

  const ctx: TurnCtx = { conv, turnId: uid('turn_'), lang, actor: 'agent', calls: [], toolFailures: 0, handover: null };
  let result: { reply: Reply; mode: Mode; understood?: boolean; grounding?: TurnResult['grounding']; llmFallback?: boolean };
  try {
    result = await route(ctx, content, opts.payload, ents, intent);
  } catch (e: any) {
    log.error('engine error', { error: e.message, stack: e.stack?.split('\n').slice(0, 3).join(' | ') });
    result = { reply: { text: t(lang, 'tool_down'), buttons: [{ id: 'callback', label: t(lang, 'b_callback') }] }, mode: 'rules' };
  }
  refresh(ctx);

  // ---- post-turn handover rules
  const s = getSettings().handover;
  const unresolved = result.understood === false ? ctx.conv.unresolved_count + 1 : 0;
  updateConversation(ctx.conv.id, { unresolved_count: unresolved } as any);
  refresh(ctx);
  if (!ctx.handover && ctx.conv.tool_failures >= s.maxToolFailures) ctx.handover = { code: 'tool_failure', reason: `Tools failed ${ctx.conv.tool_failures} times in this chat (courier/order systems unreachable).` };
  if (!ctx.handover && unresolved >= s.maxUnresolvedTurns) ctx.handover = { code: 'unclear_request', reason: `Agent could not understand the request ${unresolved} times in a row.` };

  let handoverInfo: TurnResult['handover'] = null;
  if (ctx.handover) {
    const h = await handover(ctx.conv.id, { code: ctx.handover.code, reason: ctx.handover.reason, lang });
    const replace = ['legal_threat', 'angry_customer', 'customer_request', 'tool_failure', 'unclear_request', 'verification_failed'];
    const prefix = result.reply.text && !replace.includes(ctx.handover.code) ? `${result.reply.text}\n\n` : '';
    result.reply = { text: `${prefix}${h.reply.text}` };
    handoverInfo = { ...ctx.handover, ticketId: h.ticketId };
  }

  const latencyMs = Date.now() - started;
  const msg = await sendToCustomer(ctx.conv.id, result.reply, {
    meta: { mode: result.mode, intent, latencyMs, toolCallIds: ctx.calls.map((c) => c.id), handover: handoverInfo, grounding: result.grounding ?? null, llmFallback: result.llmFallback ?? false, turnId: ctx.turnId },
  });
  return {
    reply: result.reply, mode: result.mode, intent, latencyMs, handover: handoverInfo, grounding: result.grounding ?? null, messageId: msg?.id, llmFallback: result.llmFallback,
    toolCalls: ctx.calls.map((c) => ({ name: c.name, input: c.input, output: c.output, ok: c.ok })),
  };
}

async function route(ctx: TurnCtx, text: string, payload: string | undefined, ents: Entities, intent: Intent) {
  const lang = ctx.lang;
  const flow = (reply: Reply) => ({ reply, mode: 'flow' as Mode });

  // ---------------------------------------------------------------- A. buttons
  if (payload) {
    const r = await handlePayload(ctx, payload);
    if (r) return flow(r);
  }

  // ---------------------------------------------------------------- B. safety guards (no LLM involved)
  const inj = detectInjection(text);
  if (inj) {
    const n = ctx.conv.injection_attempts + 1;
    updateConversation(ctx.conv.id, { injection_attempts: n, pending_action: null } as any);
    if (n >= 2 && getSettings().handover.handoverOnInjectionRepeat) ctx.handover = { code: 'injection_attempts', reason: `${n} attempts to override the assistant's rules (latest: "${inj}").` };
    return { reply: { text: t(lang, 'injection') }, mode: 'guard' as Mode };
  }
  const leak = detectDataLeak(text, ents, ctx.conv.verified_phone);
  if (leak) return { reply: { text: t(lang, 'data_leak') }, mode: 'guard' as Mode };
  // Verify early (order id + phone in the message) so even a handover ticket carries the order context.
  const v = await verifyFromEntities(ctx, ents);
  const trig = detectHandoverTrigger(text, getSettings().handover);
  if (trig) { ctx.handover = trig; return { reply: { text: '' }, mode: 'guard' as Mode }; }

  // ---------------------------------------------------------------- C. pending confirmation
  const pending = ctx.conv.pending_action;
  if (pending) {
    if (isAffirmative(text)) return runPending(ctx);
    if (isNegative(text)) { updateConversation(ctx.conv.id, { pending_action: null } as any); return flow({ text: t(lang, 'action_cancelled') }); }
    updateConversation(ctx.conv.id, { pending_action: null } as any);
    refresh(ctx);
  }

  // ---------------------------------------------------------------- D. flows waiting for specific input
  const f = ctx.conv.flow;
  if (f?.type === 'awaiting_address') {
    if (ents.pincodes.length && text.length >= 15) return { ...(await proposeAddress(ctx, f.orderId, text, ents.pincodes[0], f.purpose === 'ndr' ? 'ndr' : 'change')), mode: 'flow' as Mode };
    if (/\d/.test(text) && text.split(/\s+/).length >= 3 && !isNegative(text)) return flow({ text: t(lang, 'address_unclear') });
    updateConversation(ctx.conv.id, { flow: f.purpose === 'ndr' ? { type: 'ndr', orderId: f.orderId } : null } as any); refresh(ctx);
    if (isNegative(text)) return flow({ text: t(lang, 'action_cancelled') });
  }
  if (f?.type === 'awaiting_phone') {
    if (ents.phones.length) {
      const r = await runTool(ctx, 'ndr_action', { order_id: f.orderId, action: 'alternate_phone', phone: ents.phones[0] });
      if (r.error === 'TOOL_UNAVAILABLE') return flow({ text: t(lang, 'tool_down') });
      return flow({ text: t(lang, 'ndr_phone_done', { orderId: f.orderId, phone: ents.phones[0] }) });
    }
    if (/\d{5,}/.test(text)) return flow({ text: t(lang, 'ndr_phone_bad') });
    updateConversation(ctx.conv.id, { flow: { type: 'ndr', orderId: f.orderId } } as any); refresh(ctx);
  }
  if (f?.type === 'awaiting_rto_reason') {
    updateConversation(ctx.conv.id, { flow: { type: 'ndr', orderId: f.orderId } } as any); refresh(ctx);
    if (!isNegative(text) || text.split(' ').length > 3) {
      const r = await runTool(ctx, 'ndr_action', { order_id: f.orderId, action: 'cancel_order', reason: text.slice(0, 200) });
      if (r.status === 'AWAITING_CUSTOMER_CONFIRMATION') return flow({ text: r.confirmation_question, buttons: ctx.buttons });
    }
  }
  if (f?.type === 'awaiting_refund_method') {
    const m = /\b(bank|account|transfer|neft|imps|upi)\b/i.test(text) ? 'bank_transfer' : /\b(store|credit|wallet|coupon|voucher)\b/i.test(text) ? 'store_credit' : null;
    if (m) {
      updateConversation(ctx.conv.id, { flow: null } as any); refresh(ctx);
      const d = f.data ?? {};
      const r = await runTool(ctx, 'create_return_request', { order_id: f.orderId, item_id: d.itemId, reason: d.reason, refund_method: m, damage_claim: d.damageClaim, has_photo: d.hasPhoto });
      if (r.status === 'AWAITING_CUSTOMER_CONFIRMATION') return flow({ text: r.confirmation_question, buttons: ctx.buttons });
    }
  }

  // ---------------------------------------------------------------- E. quick paths inside COD / NDR flows
  if (ctx.conv.flow?.type === 'cod_confirm' && (isAffirmative(text) || /^(confirm|confirmed|haan confirm|confirm (it|kar ?do|karo|order))\b/i.test(text.trim()))) {
    const r = await runTool(ctx, 'cod_order_action', { order_id: ctx.conv.flow.orderId, action: 'confirm' });
    if (r.ok) return flow({ text: r.message });
  }
  if (ctx.conv.flow?.type === 'ndr' && ents.date) {
    const r = await runTool(ctx, 'ndr_action', { order_id: ctx.conv.flow.orderId, action: 'reschedule', date: ents.date });
    if (r.ok) return flow({ text: t(lang, 'ndr_rescheduled', { orderId: ctx.conv.flow?.orderId ?? r.order_id, date: `${r.date}T06:00:00Z` }) });
    if (r.error === 'DATE_NOT_ALLOWED') return flow({ text: t(lang, 'ndr_bad_date'), buttons: ctx.buttons });
    if (r.error === 'TOOL_UNAVAILABLE') return flow({ text: t(lang, 'tool_down') });
  }

  // ---------------------------------------------------------------- F. verification result (computed above)
  if (v === 'failed') return { reply: { text: t(lang, 'verify_failed') }, mode: 'verification' as Mode };
  if (v === 'locked') { ctx.handover = { code: 'verification_failed', reason: 'Order ID / phone did not match after repeated attempts.' }; return { reply: { text: t(lang, 'verify_locked') }, mode: 'verification' as Mode }; }

  // ---------------------------------------------------------------- G. agent
  if (llmAvailable()) {
    try {
      return await llmTurn(ctx, text, intent);
    } catch (e: any) {
      log.warn('LLM turn failed, using rule-based fallback', { error: e.message });
      const r = await ruleAgent(ctx, text, ents, intent);
      return { reply: r.reply, mode: 'rules' as Mode, understood: r.understood, llmFallback: true };
    }
  }
  const r = await ruleAgent(ctx, text, ents, intent);
  return { reply: r.reply, mode: 'rules' as Mode, understood: r.understood };
}

async function runPending(ctx: TurnCtx) {
  try {
    const action = ctx.conv.pending_action!;
    const t0 = Date.now();
    const r = await executePending(ctx.conv, action, ctx.lang);
    const id = uid('tc_');
    // confirmed actions are part of the tool trace too (what changed, after which "yes")
    getDb().prepare(`INSERT INTO tool_calls(id,conversation_id,turn_id,name,input,output,ok,error,duration_ms,actor,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, ctx.conv.id, ctx.turnId, `confirmed:${action.type}`, JSON.stringify(maskDeep(action.params)), JSON.stringify(maskDeep({ ok: r.ok, ...r.facts })), r.ok ? 1 : 0, null, Date.now() - t0, 'agent', nowIso());
    ctx.calls.push({ id, name: `confirmed:${action.type}`, input: action.params, output: r.facts, ok: r.ok, durationMs: Date.now() - t0 });
    refresh(ctx);
    return { reply: r.reply, mode: 'flow' as Mode };
  } catch (e: any) {
    log.error('pending action failed', { error: e.message });
    updateConversation(ctx.conv.id, { tool_failures: ctx.conv.tool_failures + 1 } as any);
    return { reply: { text: t(ctx.lang, 'tool_down'), buttons: [{ id: 'callback', label: t(ctx.lang, 'b_callback') }] }, mode: 'flow' as Mode };
  }
}

/** Code-level verification: if the message (plus earlier candidates) contains order id + phone, verify now. */
async function verifyFromEntities(ctx: TurnCtx, ents: Entities): Promise<'verified' | 'failed' | 'locked' | null> {
  const c = ctx.conv;
  const orderId = ents.orderIds[0] ?? c.candidate_order_id;
  const phone = ents.phones[0] ?? (ents.orderIds[0] && !c.verified_phone ? c.candidate_phone : c.candidate_phone);
  if (orderId && c.verified_orders.includes(orderId)) return null;
  if (orderId && c.verified_phone) {
    const o = getOrder(orderId);
    if (o && o.phone === c.verified_phone) { updateConversation(c.id, { verified_orders: [...c.verified_orders, o.id], context_order_id: o.id } as any); refresh(ctx); return 'verified'; }
  }
  if (orderId && phone) {
    if (c.verify_attempts >= getSettings().handover.maxVerifyAttempts) return 'locked';
    const r = await runTool(ctx, 'verify_customer', { order_id: orderId, phone }, 'system');
    refresh(ctx);
    if (r.ok) return 'verified';
    if (r.error === 'TOO_MANY_ATTEMPTS') return 'locked';
    if (ctx.conv.verify_attempts >= getSettings().handover.maxVerifyAttempts) return 'locked';
    if (r.error === 'INVALID_ARGUMENTS') return null;
    return 'failed';
  }
  const p: any = {};
  if (ents.orderIds[0]) p.candidate_order_id = ents.orderIds[0];
  if (ents.phones[0] && !c.verified_phone) p.candidate_phone = ents.phones[0];
  if (Object.keys(p).length) { updateConversation(c.id, p); refresh(ctx); }
  return null;
}

async function handlePayload(ctx: TurnCtx, payload: string): Promise<Reply | null> {
  const lang = ctx.lang;
  const [kind, a, b] = payload.split(':');
  if (kind === 'confirm') {
    if (!ctx.conv.pending_action) return { text: t(lang, 'action_cancelled') };
    if (a === 'yes') return (await runPending(ctx)).reply;
    updateConversation(ctx.conv.id, { pending_action: null } as any);
    return { text: t(lang, 'action_cancelled') };
  }
  if (kind === 'callback') {
    await runTool(ctx, 'request_callback', { reason: 'Customer requested a callback after a failed lookup.' });
    return { text: t(lang, 'callback_created') };
  }
  if (kind === 'cod' && b) {
    const action = a === 'prepaid' ? 'switch_to_prepaid' : a;
    const r = await runTool(ctx, 'cod_order_action', { order_id: b, action });
    if (r.status === 'AWAITING_CUSTOMER_CONFIRMATION') return { text: r.confirmation_question, buttons: ctx.buttons };
    if (r.ok) return { text: r.message };
    if (r.error === 'NOT_PENDING_CONFIRMATION') { const o = getOrder(b); return { text: t(lang, 'cod_not_pending', { orderId: b, status: o?.status }) }; }
    return { text: t(lang, 'ask_verify') };
  }
  if (kind === 'ndr' && b) {
    const o = getOrder(b);
    if (!o || !ctx.conv.verified_orders.includes(o.id)) return { text: t(lang, 'ask_verify') };
    if (o.ndr_status !== 'open') return { text: t(lang, 'cod_not_pending', { orderId: o.id, status: o.status }) };
    if (a === 'reschedule') return { text: t(lang, 'ndr_dates'), buttons: ndrDateButtons(o.id) };
    if (a === 'address') { updateConversation(ctx.conv.id, { flow: { type: 'awaiting_address', orderId: o.id, purpose: 'ndr' } } as any); return { text: t(lang, 'address_ask') }; }
    if (a === 'phone') { updateConversation(ctx.conv.id, { flow: { type: 'awaiting_phone', orderId: o.id } } as any); return { text: t(lang, 'ndr_phone_ask') }; }
    if (a === 'rto') { updateConversation(ctx.conv.id, { flow: { type: 'awaiting_rto_reason', orderId: o.id } } as any); return { text: t(lang, 'ndr_rto_reason') }; }
  }
  if (kind === 'ndr_date' && a && b) {
    const r = await runTool(ctx, 'ndr_action', { order_id: b, action: 'reschedule', date: a });
    if (r.ok) return { text: t(lang, 'ndr_rescheduled', { orderId: b, date: `${a}T06:00:00Z` }) };
    if (r.error === 'DATE_NOT_ALLOWED') return { text: t(lang, 'ndr_bad_date'), buttons: ctx.buttons };
    if (r.error === 'TOOL_UNAVAILABLE') return { text: t(lang, 'tool_down'), buttons: [{ id: 'callback', label: t(lang, 'b_callback') }] };
    return { text: t(lang, 'cod_not_pending', { orderId: b, status: getOrder(b)?.status }) };
  }
  if (kind === 'refund_method' && a) {
    const f = ctx.conv.flow;
    if (f?.type !== 'awaiting_refund_method') return null;
    updateConversation(ctx.conv.id, { flow: null } as any); refresh(ctx);
    const d = f.data ?? {};
    const r = await runTool(ctx, 'create_return_request', { order_id: f.orderId, item_id: d.itemId, reason: d.reason, refund_method: a, damage_claim: d.damageClaim, has_photo: d.hasPhoto });
    if (r.status === 'AWAITING_CUSTOMER_CONFIRMATION') return { text: r.confirmation_question, buttons: ctx.buttons };
    return { text: t(lang, 'return_rejected', { item: 'This item', reason: r.decision?.reasons?.join(' ') ?? '' }) };
  }
  return null;
}

// ----------------------------------------------------------------------------------------- LLM turn
function history(conv: Conversation): ChatMsg[] {
  return getMessages(conv.id).slice(-16).filter((m) => m.role !== 'system' && m.content).map((m) => ({ role: m.role === 'customer' ? 'user' : 'assistant', content: m.content } as ChatMsg));
}

function corpusFor(ctx: TurnCtx, state: string) {
  const prior = getToolCalls(ctx.conv.id).map((c) => JSON.stringify(c.output));
  const thisTurn = ctx.calls.map((c) => JSON.stringify(c.output));
  const msgs = getMessages(ctx.conv.id).filter((m) => m.role === 'customer' || m.role === 'human' || (m.role === 'agent' && m.meta?.mode !== 'llm')).map((m) => m.content);
  return buildCorpus([...prior, ...thisTurn, ...msgs, POLICY_TEXT, state, config.frontendUrl]);
}

async function llmTurn(ctx: TurnCtx, _text: string, _intent: Intent) {
  const state = stateBlock(ctx.conv, ctx.lang);
  const messages: ChatMsg[] = [{ role: 'system', content: systemPrompt() }, { role: 'system', content: state }, ...history(ctx.conv)];
  const specs = toolSpecs();
  let final: string | null = null;
  for (let round = 0; round < config.llm.maxToolRounds; round++) {
    const r = await chat({ messages, tools: specs, conversationId: ctx.conv.id, purpose: 'agent' });
    if (!r.toolCalls.length) { final = r.content; break; }
    messages.push({ role: 'assistant', content: r.content, tool_calls: r.toolCalls });
    for (const tc of r.toolCalls) {
      let args: unknown = {};
      try { args = JSON.parse(tc.arguments || '{}'); } catch { args = { __invalid_json: tc.arguments }; }
      const out = await runTool(ctx, tc.name, args);
      messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: JSON.stringify(out).slice(0, 6000) });
    }
    refresh(ctx);
    if (ctx.handover) { final = null; break; }
  }
  // If the model proposed an action, make sure the exact confirmation question is in front of the customer.
  if (ctx.pendingProposed) {
    const q = ctx.pendingProposed.summary;
    if (!final || !final.includes('?')) final = `${final ? final + '\n\n' : ''}${q}`;
    ctx.buttons = ctx.buttons ?? [];
  }
  if (!final) final = ctx.handover ? '' : t(ctx.lang, 'clarify');

  // ---- grounding check
  let grounding: TurnResult['grounding'] = { checked: false, violations: [], rewritten: false, stripped: false };
  if (getSettings().agent.groundingCheck && final) {
    const corpus = corpusFor(ctx, state);
    let bad = ungrounded(final, corpus);
    grounding = { checked: true, violations: bad.map((b) => b.raw), rewritten: false, stripped: false };
    if (bad.length) {
      log.warn('grounding violation', { conversationId: ctx.conv.id, claims: bad.map((b) => b.raw) });
      try {
        const r = await chat({
          conversationId: ctx.conv.id, purpose: 'grounding_rewrite', tools: [],
          messages: [...messages, { role: 'assistant', content: final }, { role: 'user', content: `SYSTEM CHECK (not from the customer): these details in your reply are not in any tool result: ${bad.map((b) => b.raw).join(', ')}. Rewrite the reply using only facts from tool results. If a detail is unknown, leave it out. Reply with the rewritten message only.` }],
        });
        if (r.content) { final = r.content; grounding.rewritten = true; bad = ungrounded(final, corpusFor(ctx, state)); }
      } catch { /* fall through to stripping */ }
      if (bad.length) {
        final = stripClaims(final, bad) || t(ctx.lang, 'tool_down');
        grounding.stripped = true;
      }
    }
  }
  const usedTool = ctx.calls.length > 0;
  return { reply: { text: final, buttons: ctx.buttons }, mode: 'llm' as Mode, understood: usedTool || _intent !== 'unknown', grounding };
}

/** Human agent sends a message from the dashboard. */
export async function sendHumanMessage(conversationId: string, text: string, agentName: string) {
  const conv = getConversation(conversationId);
  if (!conv) throw Object.assign(new Error('Conversation not found'), { status: 404 });
  if (conv.status !== 'human') updateConversation(conv.id, { status: 'human', assigned_to: agentName } as any);
  return sendToCustomer(conv.id, { text }, { role: 'human', meta: { agent: agentName } });
}

export { addMessage };
export type { HandoverCode };
