#!/usr/bin/env node
/**
 * wl — operate Wishluck Ops from the terminal.
 * Talks to a running backend over its HTTP API (same endpoints the dashboard uses), so it works
 * against local, Docker or deployed servers alike.
 *
 *   npx wishluck-ops help      (or: npm i -g wishluck-ops → wl help)
 */
import { parseArgs } from 'node:util';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

// ----------------------------------------------------------------------------- output helpers (monochrome)
const tty = stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code: string) => (s: string | number) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const b = sgr('1'), dim = sgr('2'), inv = sgr('7'), ul = sgr('4');
const out = (...a: unknown[]) => console.log(...a);
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const pad = (s: string, n: number) => { const v = strip(s).length; return v >= n ? s : s + ' '.repeat(n - v); };
const cut = (s: string, n: number) => (strip(s).length > n ? `${strip(s).slice(0, n - 1)}…` : s);
const inr = (n?: number | null) => (n == null ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`);
const ago = (iso?: string | null) => {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  return s < 60 ? 'now' : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—');
const lbl = (s?: string | null) => (s ?? '').replace(/_/g, ' ');

function table(rows: Record<string, string>[], cols: { key: string; title: string; max?: number }[]) {
  if (!rows.length) return out(dim('  (nothing)'));
  const w = cols.map((c) => Math.min(c.max ?? 60, Math.max(c.title.length, ...rows.map((r) => strip(r[c.key] ?? '').length))));
  out(cols.map((c, i) => dim(pad(c.title, w[i]))).join('  '));
  for (const r of rows) out(cols.map((c, i) => pad(cut(r[c.key] ?? '', w[i]), w[i])).join('  '));
}
const section = (t: string) => out(`\n${b(t)}`);
const kv = (pairs: [string, unknown][]) => { const w = Math.max(...pairs.map(([k]) => k.length)); for (const [k, v] of pairs) out(`  ${dim(pad(k, w))}  ${v ?? '—'}`); };

const STATUS: Record<string, string> = { ai: '◇ AI', needs_human: '● NEEDS PERSON', human: '◆ human', resolved: '✓ resolved' };
const statusTag = (s: string) => (s === 'needs_human' && tty ? inv(` ${STATUS[s]} `) : STATUS[s] ?? s);
const riskTag = (band?: string | null, score?: number | null) => (!band ? '—' : band === 'high' ? b(`▲ ${score} high`) : band === 'medium' ? `◆ ${score} med` : dim(`▽ ${score} low`));

// ----------------------------------------------------------------------------- HTTP
const BASE = (process.env.WL_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, '');
const TOKEN = process.env.DASHBOARD_TOKEN || '';

async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', ...(TOKEN ? { 'x-dashboard-token': TOKEN } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new Error(`Can't reach the server at ${BASE}. Start it with \`npm run dev\` (or set WL_URL).`);
  }
  const text = await res.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : `HTTP ${res.status} ${JSON.stringify(data?.error ?? data).slice(0, 200)}`);
  return data as T;
}

/** Minimal SSE reader on top of fetch. */
async function stream(path: string, onEvent: (e: any) => void, signal?: AbortSignal) {
  const res = await fetch(`${BASE}${path}${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ''}`, { signal });
  if (!res.ok || !res.body) throw new Error(`stream failed: HTTP ${res.status}`);
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body as any) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (data) { try { onEvent(JSON.parse(data)); } catch { /* ignore */ } }
    }
  }
}

const resolveConv = async (prefix: string) => {
  if (!prefix) throw new Error('conversation id required (see `wl inbox`)');
  if (prefix.startsWith('c_') && prefix.length >= 14) return prefix;
  const list = await api<any[]>('/api/conversations');
  const hit = list.filter((c) => c.id.includes(prefix) || (c.orderId ?? '').toUpperCase() === prefix.toUpperCase());
  if (hit.length === 1) return hit[0].id as string;
  if (!hit.length) throw new Error(`No conversation matches "${prefix}"`);
  throw new Error(`"${prefix}" matches ${hit.length} conversations: ${hit.map((h) => h.id).join(', ')}`);
};
const orderId = (s?: string) => { if (!s) throw new Error('order id required, e.g. WL10234'); return `WL${s.replace(/\D/g, '')}`; };

// ----------------------------------------------------------------------------- commands
type Cmd = { usage: string; help: string; run: (args: string[], flags: Record<string, any>) => Promise<void> };

function printReply(reply: any, prefix = '') {
  if (!reply) return;
  for (const line of String(reply.text).split('\n')) out(`${prefix}${line}`);
  if (reply.buttons?.length) out(prefix + reply.buttons.map((x: any, i: number) => inv(` ${i + 1} ${x.label} `)).join(' '));
}

async function chatRepl(flags: Record<string, any>) {
  let id: string = flags.id ? await resolveConv(flags.id) : (await api('/api/chat', { body: {} })).conversationId;
  let buttons: { id: string; label: string }[] = [];
  out(`${b('Wishluck support chat')} ${dim(`· conversation ${id} · ${BASE}`)}`);
  out(dim('Type as the customer. Numbers tap the last buttons. /help for commands.\n'));
  if (flags.id) {
    const h = await api<any>(`/api/chat/${id}/messages`);
    for (const m of h.messages) out(m.role === 'customer' ? `${b('you')}  ${m.content}` : `${b(m.role === 'human' ? 'team' : 'bot')}  ${m.content}`);
    buttons = h.messages.at(-1)?.buttons ?? [];
    if (buttons.length) out(buttons.map((x, i) => inv(` ${i + 1} ${x.label} `)).join(' '));
  }
  // live: show messages that arrive outside our own turn (COD/NDR proactive messages, human agent replies)
  const ctrl = new AbortController();
  let awaiting = false;
  const seen = new Set<string>();
  stream(`/api/chat/${id}/stream`, (e) => {
    if (e.type !== 'message' || seen.has(e.message.id)) return;
    seen.add(e.message.id);
    if (awaiting || e.message.role === 'customer') return;
    out(`\n${b(e.message.role === 'human' ? 'team' : 'bot')}  ${e.message.content}`);
    if (e.message.buttons?.length) { buttons = e.message.buttons; out(buttons.map((x, i) => inv(` ${i + 1} ${x.label} `)).join(' ')); }
    rl.prompt(true);
  }, ctrl.signal).catch(() => {});

  const rl = readline.createInterface({ input: stdin, output: stdout, prompt: `${b('you')}  ` });
  rl.prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) { rl.prompt(); continue; }
    if (line === '/quit' || line === '/exit') break;
    if (line === '/help') { out(dim('  /new  start a new chat · /id  show conversation id · /quit  leave · 1-9  tap a button')); rl.prompt(); continue; }
    if (line === '/id') { out(dim(`  ${id}`)); rl.prompt(); continue; }
    if (line === '/new') { id = (await api('/api/chat', { body: {} })).conversationId; buttons = []; out(dim(`  new conversation ${id}`)); rl.prompt(); continue; }
    let body: any = { text: line, clientMessageId: `cli${Date.now()}` };
    const n = Number(line);
    if (Number.isInteger(n) && n >= 1 && n <= buttons.length) { body = { text: buttons[n - 1].label, payload: buttons[n - 1].id, clientMessageId: `cli${Date.now()}` }; out(dim(`  → ${buttons[n - 1].label}`)); }
    awaiting = true;
    const t0 = Date.now();
    try {
      const r = await api<any>(`/api/chat/${id}/messages`, { body });
      if (r.paused) out(dim('  (a person is handling this chat — your message was delivered to them)'));
      else if (r.reply) { printReply({ text: `${b('bot')}  ${r.reply.text}`, buttons: r.reply.buttons }); out(dim(`     ${Date.now() - t0} ms${r.handover ? ' · handed over to a person' : ''}`)); }
      buttons = r.reply?.buttons ?? [];
      const msgs = await api<any>(`/api/chat/${id}/messages`);
      for (const m of msgs.messages) seen.add(m.id);
    } catch (e: any) { out(`  ✕ ${e.message}`); }
    awaiting = false;
    rl.prompt();
  }
  ctrl.abort();
  rl.close();
  out(dim(`\nbye — conversation ${id}`));
}

async function showConversation(id: string, flags: Record<string, any>) {
  const d = await api<any>(`/api/conversations/${id}`);
  const c = d.conversation;
  out(`${b(c.customer_name ?? 'Website visitor')} ${dim(c.customer_phone ?? '')}  ${statusTag(c.status)}  ${dim(`${c.channel} · ${c.language} · ${c.verified_orders.length ? `verified ${c.verified_orders.join(', ')}` : 'not verified'}${c.mood ? ` · ${c.mood}` : ''}`)}`);
  out(dim(`id ${c.id} · started ${when(c.created_at)}`));
  if (c.status === 'needs_human') out(`\n${inv(' HANDED OVER ')} ${b(c.handoverLabel ?? lbl(c.handover_code))} — ${c.handover_reason}`);
  section('Conversation');
  const calls = new Map(d.toolCalls.map((t: any) => [t.id, t]));
  for (const m of d.messages) {
    if (m.role === 'system') { out(dim(`  ── ${m.content} ──`)); continue; }
    const ids: string[] = m.meta?.toolCallIds ?? [];
    if (ids.length && !flags.quiet) out(dim(`        ⚙ ${ids.map((i) => calls.get(i)).filter(Boolean).map((t: any) => `${t.ok ? '✓' : '✕'} ${t.name}`).join('  ')}`));
    const who = m.role === 'customer' ? 'cust' : m.role === 'human' ? 'team' : 'bot ';
    const meta = m.role === 'agent' ? dim(` [${m.meta?.kind ? `auto:${m.meta.kind}` : m.meta?.mode ?? ''}${m.meta?.latencyMs != null ? ` ${m.meta.latencyMs}ms` : ''}]`) : '';
    const lines = String(m.content).split('\n');
    out(`  ${dim(new Date(m.created_at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }))} ${b(who)}  ${lines[0]}${meta}`);
    for (const l of lines.slice(1)) out(`              ${l}`);
    if (m.meta?.buttons?.length) out(`              ${m.meta.buttons.map((x: any) => `[${x.label}]`).join(' ')}`);
  }
  if (flags.tools) {
    section('Tool calls');
    for (const t of d.toolCalls) {
      out(`  ${t.ok ? '✓' : '✕'} ${b(t.name)} ${dim(`${t.duration_ms}ms${t.actor === 'system' ? ' · run by engine' : ''}${t.error ? ` · ${t.error}` : ''}`)}`);
      out(dim(`      in  ${JSON.stringify(t.input)}`));
      out(dim(`      out ${cut(JSON.stringify(t.output), 400)}`));
    }
  }
  const ticket = d.tickets.find((t: any) => t.status === 'open' && t.reason_code !== 'callback');
  if (ticket) {
    section(`Ticket ${ticket.id} · ${ticket.priority} priority · mood ${ticket.mood}`);
    out(ticket.summary.split('\n').map((l: string) => `  ${l}`).join('\n'));
    out(`\n  ${dim('Suggested reply:')}\n  ${ticket.suggested_reply}`);
    out(dim(`\n  send it:  wl reply ${c.id.slice(-6)} --suggested`));
  }
}

const COMMANDS: Record<string, Cmd> = {
  chat: { usage: 'chat [--id <conv>]', help: 'Chat as a customer (interactive). Numbers tap buttons. Proactive COD/NDR messages appear live.', run: (_a, f) => chatRepl(f) },
  say: {
    usage: 'say "<text>" [--id <conv>]', help: 'Send one customer message and print the reply (creates a chat unless --id).',
    run: async (a, f) => {
      const id = f.id ? await resolveConv(f.id) : (await api('/api/chat', { body: {} })).conversationId;
      const r = await api<any>(`/api/chat/${id}/messages`, { body: { text: a.join(' ') } });
      printReply(r.reply ?? { text: dim('(paused — a person is handling this chat)') });
      out(dim(`conversation ${id}`));
    },
  },
  inbox: {
    usage: 'inbox [--status ai|needs_human|human|resolved]', help: 'List conversations (handovers first).',
    run: async (_a, f) => {
      const list = await api<any[]>(`/api/conversations${f.status ? `?status=${f.status}` : ''}`);
      list.sort((x, y) => (x.status === 'needs_human' ? -1 : 0) - (y.status === 'needs_human' ? -1 : 0));
      table(list.map((c) => ({ id: c.id.slice(-6), status: statusTag(c.status), who: c.customer, order: c.orderId ?? '', why: c.handoverLabel && c.status === 'needs_human' ? c.handoverLabel : c.flow ? lbl(c.flow) : '', last: c.lastMessage?.replace(/\s+/g, ' ') ?? '', age: ago(c.lastMessageAt) })),
        [{ key: 'id', title: 'ID' }, { key: 'status', title: 'STATUS' }, { key: 'who', title: 'CUSTOMER', max: 18 }, { key: 'order', title: 'ORDER' }, { key: 'why', title: 'REASON / FLOW', max: 28 }, { key: 'last', title: 'LAST MESSAGE', max: 52 }, { key: 'age', title: 'AGE' }]);
      out(dim(`\n${list.length} conversations · open one: wl show <id>`));
    },
  },
  show: { usage: 'show <conv> [--tools] [--quiet]', help: 'Full transcript, tool calls (--tools for inputs/outputs) and the handover ticket.', run: async (a, f) => showConversation(await resolveConv(a[0]), f) },
  takeover: { usage: 'takeover <conv> [--as <name>]', help: 'Take a chat over from the AI.', run: async (a, f) => { const id = await resolveConv(a[0]); await api(`/api/conversations/${id}/takeover`, { body: { agent: f.as ?? 'CLI agent' } }); out(`✓ you're handling ${id} — the AI is paused`); } },
  reply: {
    usage: 'reply <conv> "<text>" | --suggested [--as <name>]', help: 'Reply as a person (takes over if needed). --suggested sends the ticket\'s suggested reply.',
    run: async (a, f) => {
      const id = await resolveConv(a[0]);
      let text = a.slice(1).join(' ');
      if (f.suggested) { const d = await api<any>(`/api/conversations/${id}`); text = d.tickets.find((t: any) => t.status === 'open')?.suggested_reply ?? ''; }
      if (!text) throw new Error('nothing to send');
      await api(`/api/conversations/${id}/messages`, { body: { text, agent: f.as ?? 'CLI agent' } });
      out(`✓ sent to ${id}: ${dim(cut(text, 90))}`);
    },
  },
  handback: { usage: 'handback <conv>', help: 'Give the chat back to the AI.', run: async (a) => { const id = await resolveConv(a[0]); await api(`/api/conversations/${id}/handback`, { body: {} }); out(`✓ AI is handling ${id} again`); } },
  resolve: { usage: 'resolve <conv>', help: 'Mark a conversation resolved (closes its tickets).', run: async (a) => { const id = await resolveConv(a[0]); await api(`/api/conversations/${id}/resolve`, { body: {} }); out(`✓ resolved ${id}`); } },
  tickets: {
    usage: 'tickets [--all]', help: 'Open handover tickets (or all).',
    run: async (_a, f) => {
      const t = await api<any[]>(`/api/tickets${f.all ? '' : '?status=open'}`);
      table(t.map((x) => ({ id: x.id, pr: x.priority === 'high' ? b('▲ high') : x.priority, reason: lbl(x.reason_code), order: x.order_id ?? '', mood: x.mood ?? '', conv: x.conversation_id?.slice(-6) ?? '', summary: x.summary.split('\n')[0], age: ago(x.created_at) })),
        [{ key: 'id', title: 'TICKET' }, { key: 'pr', title: 'PRIORITY' }, { key: 'reason', title: 'REASON' }, { key: 'order', title: 'ORDER' }, { key: 'mood', title: 'MOOD' }, { key: 'conv', title: 'CHAT' }, { key: 'summary', title: 'SUMMARY', max: 60 }, { key: 'age', title: 'AGE' }]);
    },
  },
  orders: {
    usage: 'orders [--view cod|awaiting|hold|high|ndr|rto] [--q <text>]', help: 'List orders with COD confirmation, risk and failed attempts.',
    run: async (_a, f) => {
      const q: Record<string, string> = { cod: 'payment=cod', awaiting: 'confirmation=pending', hold: 'confirmation=on_hold', high: 'risk=high', ndr: 'ndr=1', rto: 'status=rto_initiated' };
      const params = [f.view ? q[f.view] : '', f.q ? `q=${encodeURIComponent(f.q)}` : ''].filter(Boolean).join('&');
      if (f.view && !q[f.view]) throw new Error(`unknown view "${f.view}" (${Object.keys(q).join(', ')})`);
      const list = await api<any[]>(`/api/orders${params ? `?${params}` : ''}`);
      table(list.map((o) => ({ id: o.id, who: o.name, pay: o.payment_method.toUpperCase(), total: inr(o.total), status: o.status === 'delivery_failed' || o.status === 'on_hold' ? b(lbl(o.status)) : lbl(o.status), cod: o.cod_confirmation === 'not_required' ? '' : lbl(o.cod_confirmation), risk: riskTag(o.risk_band, o.risk_score), ndr: o.ndr_attempts ? `${o.ndr_attempts}× ${lbl(o.ndr_status)}` : '', age: ago(o.created_at) })),
        [{ key: 'id', title: 'ORDER' }, { key: 'who', title: 'CUSTOMER', max: 16 }, { key: 'pay', title: 'PAY' }, { key: 'total', title: 'TOTAL' }, { key: 'status', title: 'STATUS' }, { key: 'cod', title: 'COD CONFIRM' }, { key: 'risk', title: 'RISK' }, { key: 'ndr', title: 'FAILED' }, { key: 'age', title: 'AGE' }]);
      out(dim(`\n${list.length} orders · details: wl order <id>`));
    },
  },
  order: {
    usage: 'order <id> [--audit]', help: 'Order detail: items, risk reasons, courier timeline, notes (--audit for the change log).',
    run: async (a, f) => {
      const d = await api<any>(`/api/orders/${orderId(a[0])}`);
      const o = d.order;
      out(`${b(o.id)}  ${lbl(o.status)}  ${o.payment_method.toUpperCase()} ${inr(o.total)}  ${dim(`${o.name} · ${o.phone} · placed ${when(o.created_at)}`)}`);
      out(dim(`  ${[o.address_line1, o.landmark, o.city, o.pincode].filter(Boolean).join(', ')}`));
      section('Items');
      for (const i of o.items) out(`  ${i.name}${i.size && i.size !== 'ONE' ? ` · ${i.size}` : ''} × ${i.qty}  ${dim(inr(i.price * i.qty))}`);
      out(dim(`  shipping ${inr(o.shipping_fee)} · COD fee ${inr(o.cod_fee)} · discount −${inr(o.discount)}`));
      if (o.cod_confirmation !== 'not_required') {
        section(`COD risk ${riskTag(o.risk_band, o.risk_score)} · confirmation: ${lbl(o.cod_confirmation)}`);
        for (const r of o.risk_reasons ?? []) out(`  ${pad(r.points > 0 ? `+${r.points}` : String(r.points), 4)} ${r.detail}`);
      }
      if (d.tracking?.timeline) {
        section(`Courier ${o.courier ?? ''} ${o.awb ?? ''}${o.ndr_attempts ? ` · ${o.ndr_attempts} failed (${lbl(o.ndr_status)})` : ''}`);
        for (const t of [...d.tracking.timeline].reverse().slice(0, 8)) out(`  ${dim(when(t.at))}  ${pad(lbl(t.status), 18)} ${dim([t.location, t.note].filter(Boolean).join(' · '))}`);
      }
      if (d.returns?.length || d.refunds?.length) {
        section('Returns & refunds');
        for (const r of d.returns) out(`  ${r.id}  ${r.type}  ${lbl(r.status)}${r.new_size ? ` → ${r.new_size}` : ''}`);
        for (const r of d.refunds) out(`  ${r.refund_id}  ${inr(r.amount)}  ${lbl(r.status)}  ${dim(r.method_label)}`);
      }
      if (o.notes?.length) { section('Notes'); for (const n of o.notes) out(`  ${dim(when(n.at))} ${n.text}`); }
      if (d.conversations?.length) out(dim(`\nchats: ${d.conversations.map((c: any) => `${c.id.slice(-6)} (${c.status})`).join(', ')}`));
      if (f.audit) {
        section('Audit log');
        table(d.audit.map((x: any) => ({ at: when(x.created_at), field: x.field, change: `${cut(x.old_value ?? '∅', 30)} → ${cut(x.new_value ?? '∅', 40)}`, by: x.actor, why: x.reason ?? '' })),
          [{ key: 'at', title: 'WHEN' }, { key: 'field', title: 'FIELD' }, { key: 'change', title: 'OLD → NEW', max: 72 }, { key: 'by', title: 'BY' }, { key: 'why', title: 'REASON', max: 40 }]);
      }
    },
  },
  'new-order': {
    usage: 'new-order [high_risk|low_risk|repeat_refuser|prepaid] [--dup]', help: 'Create a test order through the signed order webhook (--dup sends it twice).',
    run: async (a, f) => {
      const preset = a[0] ?? 'high_risk';
      const r = await api<any>('/api/test/orders', { body: { preset, duplicate: !!f.dup } });
      out(`✓ ${b(r.orderId)} sent via signed webhook (${preset})${f.dup ? ` · second delivery → ${r.duplicateResponse?.duplicate ? 'ignored as duplicate' : JSON.stringify(r.duplicateResponse)}` : ''}`);
      await new Promise((res) => setTimeout(res, 1500));
      const o = (await api<any>(`/api/orders/${r.orderId}`)).order;
      if (o.risk_band) out(`  risk ${riskTag(o.risk_band, o.risk_score)} — ${o.risk_reasons.map((x: any) => x.signal).join(', ')}`);
      out(dim(`  confirmation goes out within the configured delay · see it: wl order ${r.orderId} / wl inbox`));
    },
  },
  courier: {
    usage: 'courier <order> <picked_up|in_transit|out_for_delivery|delivery_failed|delivered|rto_initiated> [--reason "..."] [--dup]',
    help: 'Make the mock courier send a signed status webhook.',
    run: async (a, f) => {
      const [id, status] = [orderId(a[0]), a[1]];
      if (!status) throw new Error('status required');
      const r = await api<any>(`/api/test/courier/${id}`, { body: { status, reason: f.reason, duplicate: !!f.dup } });
      out(`✓ courier → ${b(lbl(status))} for ${id} (${r.awb})${f.reason ? ` · "${f.reason}"` : ''}${f.dup ? ' · sent twice' : ''}`);
    },
  },
  action: {
    usage: 'action <order> <confirm|cancel|resend_confirmation|release_hold|note> [--note "..."]', help: 'Ops action on an order.',
    run: async (a, f) => { const id = orderId(a[0]); await api(`/api/orders/${id}/actions`, { body: { action: a[1], note: f.note, agent: 'cli' } }); out(`✓ ${lbl(a[1])} → ${id}`); },
  },
  watch: {
    usage: 'watch', help: 'Live feed of what the system is doing (messages, handovers, order changes). Ctrl+C to stop.',
    run: async () => {
      out(dim(`watching ${BASE} … Ctrl+C to stop\n`));
      const names = new Map<string, string>();
      const label = async (cid: string) => {
        if (!names.has(cid)) { try { const d = await api<any>(`/api/conversations/${cid}`); names.set(cid, d.conversation.customer_name ?? 'visitor'); } catch { names.set(cid, cid.slice(-6)); } }
        return names.get(cid)!;
      };
      const lastMsg = new Map<string, string>();
      const lastOrder = new Map<string, string>();
      const ts = () => dim(new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', second: '2-digit' }));
      await stream('/api/stream', async (e) => {
        if (e.type === 'message.created') {
          const d = await api<any>(`/api/conversations/${e.conversationId}`).catch(() => null);
          const m = d?.messages?.at(-1);
          if (!m || lastMsg.get(e.conversationId) === m.id) return;
          lastMsg.set(e.conversationId, m.id);
          const who = m.role === 'customer' ? 'cust' : m.role === 'human' ? 'team' : m.role === 'system' ? 'sys ' : 'bot ';
          out(`${ts()} ${pad(cut(await label(e.conversationId), 14), 14)} ${b(who)} ${cut(String(m.content).replace(/\s+/g, ' '), 100)}`);
        } else if (e.type === 'ticket.created') {
          out(`${ts()} ${inv(' HANDOVER ')} ticket ${e.ticketId} · chat ${e.conversationId?.slice(-6)}`);
        } else if (e.type === 'order.updated') {
          const o = (await api<any>(`/api/orders/${e.orderId}`).catch(() => null))?.order;
          if (!o) return;
          const line = `${lbl(o.status)}${o.cod_confirmation !== 'not_required' ? ` · COD ${lbl(o.cod_confirmation)}` : ''}${o.ndr_attempts ? ` · ${o.ndr_attempts} failed` : ''}`;
          if (lastOrder.get(o.id) === line) return; // several field updates in one change → print once
          lastOrder.set(o.id, line);
          out(`${ts()} ${dim('order')} ${b(o.id)} ${line}`);
        }
      });
    },
  },
  stats: {
    usage: 'stats', help: 'Analytics summary.',
    run: async () => {
      const d = await api<any>('/api/analytics');
      const pct = (v: number) => `${Math.round(v * 100)}%`;
      section('Support');
      kv([['Solved without a person', `${pct(d.chats.aiResolutionRate)} (${d.chats.resolvedByAi}/${d.chats.total})`], ['Waiting for a person', d.chats.open], ['First response (median)', d.firstResponse.medianMs != null ? `${Math.round(d.firstResponse.medianMs)} ms` : '—'], ['Avg agent reply', d.agentLatency.avgMs != null ? `${Math.round(d.agentLatency.avgMs)} ms` : '—']]);
      section('COD & RTO');
      kv([['Confirmation rate', `${pct(d.cod.confirmationRate)} (${d.cod.confirmed} confirmed, ${d.cod.switchedPrepaid} prepaid, ${d.cod.cancelled} cancelled, ${d.cod.onHold} on hold, ${d.cod.pending} pending)`], ['Orders saved from RTO', `${d.rto.savedTotal} (${d.rto.switchedToPrepaid} → prepaid, ${d.rto.ndrResolved} NDR fixed, ${d.rto.cancelledBeforeDispatch} cancelled pre-ship)`], ['Risk bands (all COD)', `▲ ${d.cod.riskBands.high} · ◆ ${d.cod.riskBands.medium} · ▽ ${d.cod.riskBands.low}`]]);
      const bars = (items: { k: string; v: number }[]) => { const m = Math.max(1, ...items.map((i) => i.v)); for (const i of items) out(`  ${pad(cut(i.k, 26), 26)} ${'█'.repeat(Math.max(1, Math.round((i.v / m) * 24)))} ${i.v}`); };
      section('Handovers by reason'); d.handovers.length ? bars(d.handovers.map((h: any) => ({ k: h.label, v: h.count }))) : out(dim('  none'));
      section('Most common requests'); d.topRequests.length ? bars(d.topRequests.map((r: any) => ({ k: lbl(r.intent), v: r.count }))) : out(dim('  none'));
      section('LLM');
      kv([['Calls', `${d.llm.calls}${d.llm.failures ? ` (${d.llm.failures} failed)` : ''}`], ['Tokens in/out', `${d.llm.inputTokens} / ${d.llm.outputTokens}`], ['Cost', `$${d.llm.costUsd.toFixed(4)} total · $${d.llm.costPerChatUsd.toFixed(5)} per chat`]]);
    },
  },
  settings: {
    usage: 'settings [key=value ...] | settings --fast | settings --prod', help: 'Show settings, or set values with dotted keys (e.g. risk.highThreshold=55 agent.llmEnabled=false). --fast = demo timings in seconds.',
    run: async (a, f) => {
      const cur = await api<any>('/api/settings');
      let patch: any = null;
      if (f.fast) patch = { timings: cur.fastTimings };
      if (f.prod) patch = { timings: cur.defaults.timings };
      if (a.length) {
        patch = patch ?? {};
        for (const pair of a) {
          const [k, ...rest] = pair.split('=');
          const raw = rest.join('=');
          if (!k || !rest.length) throw new Error(`expected key=value, got "${pair}"`);
          const val = raw === 'true' ? true : raw === 'false' ? false : raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw.includes(',') ? raw.split(',').map((x) => x.trim()) : raw;
          const keys = k.split('.');
          let o = patch;
          for (const key of keys.slice(0, -1)) o = o[key] ??= {};
          o[keys.at(-1)!] = val;
        }
      }
      const s = patch ? (await api<any>('/api/settings', { method: 'PUT', body: patch })).settings : cur.settings;
      if (patch) out('✓ saved — applies immediately');
      const flat: [string, unknown][] = [];
      const walk = (o: any, p: string) => { for (const [k, v] of Object.entries(o)) { if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, `${p}${k}.`); else flat.push([`${p}${k}`, Array.isArray(v) ? cut(v.join(', '), 70) : v]); } };
      walk(s, '');
      kv(flat);
    },
  },
  jobs: {
    usage: 'jobs [--run]', help: 'Queue stats; --run fast-forwards every queued job (reminders, holds, follow-ups).',
    run: async (_a, f) => {
      if (f.run) { const r = await api<any>('/api/test/run-jobs', { body: {} }); out(`✓ ran ${r.ran} job(s)`); }
      const j = await api<any>('/api/jobs');
      out(`${b('queue')} ${j.driver}  ${dim(JSON.stringify(j.stats))}`);
      if (j.recent?.length) table(j.recent.slice(0, 15).map((x: any) => ({ type: x.type, key: x.job_key ?? '', status: x.status, tries: String(x.attempts), due: x.status === 'queued' ? `in ${Math.max(0, Math.round((x.run_at - Date.now()) / 1000))}s` : '', err: x.last_error ?? '' })),
        [{ key: 'type', title: 'JOB' }, { key: 'key', title: 'KEY', max: 34 }, { key: 'status', title: 'STATUS' }, { key: 'tries', title: 'TRIES' }, { key: 'due', title: 'DUE' }, { key: 'err', title: 'ERROR', max: 40 }]);
    },
  },
  health: {
    usage: 'health', help: 'Is the server up, which agent/queue is active.',
    run: async () => { const h = await api<any>('/api/health'); kv([['server', BASE], ['agent', h.llm.configured && h.llm.enabled ? `LLM ${h.llm.provider} / ${h.llm.model}` : 'rule-based (no LLM key or disabled)'], ['queue', h.queue], ['whatsapp', h.whatsapp ? 'on' : 'off']]); },
  },
  reset: {
    usage: 'reset --yes', help: 'Re-seed demo data (orders, chats, tickets are wiped).',
    run: async (_a, f) => { if (!f.yes) throw new Error('this wipes chats and tickets — add --yes'); const r = await api<any>('/api/test/reset', { body: {} }); out(`✓ re-seeded ${r.orders} orders`); },
  },
};

function help() {
  out(`${b('wl')} — Wishluck Ops from the terminal ${dim(`(server: ${BASE})`)}\n`);
  const groups: [string, string[]][] = [
    ['Customer', ['chat', 'say']],
    ['Support team', ['inbox', 'show', 'takeover', 'reply', 'handback', 'resolve', 'tickets', 'watch']],
    ['Orders & testing', ['orders', 'order', 'new-order', 'courier', 'action', 'jobs']],
    ['System', ['stats', 'settings', 'health', 'reset']],
  ];
  for (const [g, cmds] of groups) {
    out(ul(g));
    for (const c of cmds) out(`  ${pad(b(COMMANDS[c].usage.split(' ')[0]), 12)} ${COMMANDS[c].help}\n  ${' '.repeat(12)} ${dim(`wl ${COMMANDS[c].usage}`)}`);
    out('');
  }
  out(dim('Conversation ids can be shortened to their last characters, or given as an order id.\nEnv: WL_URL (default http://localhost:4000), DASHBOARD_TOKEN, NO_COLOR.'));
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true, strict: false,
    options: { id: { type: 'string' }, status: { type: 'string' }, view: { type: 'string' }, q: { type: 'string' }, reason: { type: 'string' }, note: { type: 'string' }, as: { type: 'string' },
      dup: { type: 'boolean' }, tools: { type: 'boolean' }, quiet: { type: 'boolean' }, audit: { type: 'boolean' }, suggested: { type: 'boolean' }, fast: { type: 'boolean' }, prod: { type: 'boolean' }, run: { type: 'boolean' }, all: { type: 'boolean' }, yes: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  });
  const [name, ...rest] = positionals;
  if (!name || name === 'help' || values.help) return help();
  const cmd = COMMANDS[name];
  if (!cmd) { out(`unknown command "${name}"\n`); help(); process.exitCode = 1; return; }
  await cmd.run(rest, values);
}

main().catch((e) => { console.error(`✕ ${e.message}`); process.exit(1); });
