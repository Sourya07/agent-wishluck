import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { TopBar, useLiveEvent } from '../components/Layout';
import { ConvStatus, Empty, ErrorState, JsonBlock, Loading, MOOD, OrderStatus, Spinner, useToast } from '../components/ui';
import { IBack, IBot, IChat, IExternal, IHand, IInbox, IPanel, IRefresh, ISearch, ISend, ITool, IUser } from '../components/icons';
import { api } from '../lib/api';
import { ago, dateTime, inr, initials, label, ms, time } from '../lib/format';
import { useApi, useDebounced } from '../lib/hooks';

interface ConvItem { id: string; channel: string; status: string; language: string; customer: string; phone: string | null; orderId: string | null; lastMessage: string; lastMessageAt: string; mood: string | null; handoverLabel: string | null; assignedTo: string | null; verified: boolean; priority: string | null; flow: string | null }

const FILTERS = [
  { k: 'all', t: 'All' },
  { k: 'needs_human', t: 'Needs person' },
  { k: 'ai', t: 'AI' },
  { k: 'human', t: 'Human' },
  { k: 'resolved', t: 'Resolved' },
];
const AGENT = 'Support agent';
const LANG: Record<string, string> = { en: 'EN', hinglish: 'Hinglish', hi: 'हिंदी' };

export default function Inbox() {
  const { id } = useParams();
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [side, setSide] = useState(false);
  const list = useApi<ConvItem[]>('/conversations');
  const refetch = useDebounced(() => list.reload(true), 300);
  useLiveEvent((e) => { if (['conversation.updated', 'message.created', 'ticket.created'].includes(e.type)) refetch(); });

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: list.data?.length ?? 0 };
    for (const x of list.data ?? []) c[x.status] = (c[x.status] ?? 0) + 1;
    return c;
  }, [list.data]);
  const items = (list.data ?? [])
    .filter((c) => filter === 'all' || c.status === filter)
    .filter((c) => !q || `${c.customer} ${c.orderId ?? ''} ${c.lastMessage}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (a.status === 'needs_human' ? -1 : 0) - (b.status === 'needs_human' ? -1 : 0) || (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));

  return (
    <>
      <TopBar title="Inbox" sub={`${counts.needs_human ?? 0} waiting for a person · ${counts.ai ?? 0} with the AI`}>
        <a className="btn sm" href="/store" target="_blank" rel="noreferrer"><IChat /> Open customer chat</a>
      </TopBar>
      <div className={`inbox ${id ? 'has-sel' : ''} ${side ? 'show-side' : ''}`} style={{ flex: 1, minHeight: 0 }}>
        <section className="inbox-list">
          <div className="head">
            <div className="tabs" style={{ width: '100%', overflowX: 'auto' }}>
              {FILTERS.map((f) => <button key={f.k} className={`tab ${filter === f.k ? 'active' : ''}`} onClick={() => setFilter(f.k)}>{f.t}<span className="n">{counts[f.k] ?? 0}</span></button>)}
            </div>
            <div className="row" style={{ position: 'relative' }}>
              <ISearch width={15} style={{ position: 'absolute', left: 10, color: 'var(--faint)' }} />
              <input className="input" style={{ paddingLeft: 32 }} placeholder="Search customer, order, message" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>
          <div className="items">
            {list.loading && !list.data ? <div style={{ padding: 14 }}><Loading rows={6} /></div>
              : list.error ? <div style={{ padding: 14 }}><ErrorState error={list.error} onRetry={() => list.reload()} /></div>
              : items.length === 0 ? <Empty title={q || filter !== 'all' ? 'Nothing here' : 'No conversations yet'} icon={<IInbox width={20} />}>{filter === 'all' && !q ? 'Open the storefront chat or create a test COD order — conversations appear here live.' : 'Try another filter.'}</Empty>
              : items.map((c) => (
                <Link key={c.id} to={`/inbox/${c.id}`} className={`conv ${c.id === id ? 'active' : ''} ${c.status === 'needs_human' ? 'attn' : ''}`}>
                  <div className="row"><span className="name ellipsis">{c.customer}</span><span className="time">{ago(c.lastMessageAt)}</span></div>
                  <div className="msg ellipsis">{c.lastMessage}</div>
                  <div className="meta">
                    <ConvStatus s={c.status} />
                    {c.handoverLabel && c.status === 'needs_human' && <span className="badge">{c.priority === 'high' ? '▲ ' : ''}{c.handoverLabel}</span>}
                    {c.orderId && <span className="badge soft mono">{c.orderId}</span>}
                    {c.flow === 'cod_confirm' && <span className="badge dashed">COD confirm</span>}
                    {c.flow === 'ndr' && <span className="badge dashed">Failed delivery</span>}
                    {c.channel === 'whatsapp' && <span className="badge">WhatsApp</span>}
                  </div>
                </Link>
              ))}
          </div>
        </section>
        {id ? <Thread key={id} id={id} onToggleSide={() => setSide((s) => !s)} /> : (
          <div className="thread" style={{ justifyContent: 'center', gridColumn: 'span 2' }}><Empty title="Select a conversation" icon={<IChat width={20} />}>The full chat, every tool call the agent made and the handover ticket show up here.</Empty></div>
        )}
      </div>
    </>
  );
}

function Thread({ id, onToggleSide }: { id: string; onToggleSide: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const d = useApi<any>(`/conversations/${id}`);
  const refetch = useDebounced(() => d.reload(true), 150);
  useLiveEvent((e) => { if (e.conversationId === id) refetch(); });
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [showTrace, setShowTrace] = useState(true);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [d.data?.messages?.length]);

  if (d.loading && !d.data) return <div className="thread" style={{ padding: 24 }}><Loading rows={5} /></div>;
  if (d.error) return <div className="thread" style={{ padding: 24 }}><ErrorState error={d.error} onRetry={() => d.reload()} /></div>;
  const { conversation: c, messages, toolCalls, tickets, orders, llm } = d.data;
  const ticket = tickets.find((t: any) => t.status === 'open' && t.reason_code !== 'callback') ?? tickets[0];
  const callsById = new Map(toolCalls.map((t: any) => [t.id, t]));

  const act = async (what: 'takeover' | 'handback' | 'resolve') => {
    setBusy(what);
    try { await api(`/conversations/${id}/${what}`, { body: { agent: AGENT } }); toast(what === 'takeover' ? 'You are now handling this chat' : what === 'handback' ? 'Handed back to the AI' : 'Marked resolved'); await d.reload(true); }
    catch (e: any) { toast(e.message, true); } finally { setBusy(null); }
  };
  const send = async (text = draft) => {
    if (!text.trim()) return;
    setBusy('send');
    try { await api(`/conversations/${id}/messages`, { body: { text, agent: AGENT } }); setDraft(''); await d.reload(true); }
    catch (e: any) { toast(e.message, true); } finally { setBusy(null); }
  };

  return (
    <>
      <section className="thread">
        <div className="thread-h">
          <button className="btn ghost icon-btn only-narrow" onClick={() => nav('/inbox')} aria-label="Back"><IBack /></button>
          <div className="avatar">{initials(c.customer_name ?? 'V')}</div>
          <div className="grow" style={{ minWidth: 200 }}>
            <div className="row" style={{ gap: 8 }}><span className="strong" style={{ whiteSpace: 'nowrap' }}>{c.customer_name ?? 'Website visitor'}</span>{c.customer_phone && <span className="mono muted">{c.customer_phone}</span>}</div>
            <div className="small muted ellipsis">
              {[c.channel === 'whatsapp' ? 'WhatsApp' : 'Web chat', LANG[c.language] ?? c.language, c.verified_orders.length ? `Verified for ${c.verified_orders.join(', ')}` : 'Not verified', c.mood ? MOOD[c.mood] : null].filter(Boolean).join('  ·  ')}
            </div>
          </div>
          <div className="row" style={{ gap: 6, flex: 'none' }}>
            <ConvStatus s={c.status} />
            {c.status === 'ai' || c.status === 'needs_human' ? <button className="btn sm primary" disabled={!!busy} onClick={() => act('takeover')}><IHand /> Take over</button> : null}
            {c.status === 'human' || c.status === 'needs_human' ? <button className="btn sm" disabled={!!busy} onClick={() => act('handback')} title="Hand back to AI"><IBot /> Hand back</button> : null}
            {c.status !== 'resolved' && <button className="btn sm" disabled={!!busy} onClick={() => act('resolve')}>Resolve</button>}
            <button className="btn ghost icon-btn sm only-narrow" onClick={onToggleSide} aria-label="Details"><IPanel /></button>
          </div>
        </div>
        {c.status === 'needs_human' && (
          <div className="banner"><IHand width={18} /><div><div className="strong">Handed over: {c.handoverLabel ?? label(c.handover_code)}</div><div className="small">{c.handover_reason}</div><div className="small muted">The AI has stopped replying. Take over to answer the customer.</div></div></div>
        )}
        <div className="msgs">
          <div className="row between small muted"><span>Started {dateTime(c.created_at)}</span><label className="row" style={{ gap: 6, cursor: 'pointer' }}><input type="checkbox" checked={showTrace} onChange={(e) => setShowTrace(e.target.checked)} /> Show tool calls inline</label></div>
          {messages.map((m: any) => {
            if (m.role === 'system') return <div key={m.id} className="sys">{m.content} · {time(m.created_at)}</div>;
            const out = m.role !== 'customer';
            const calls = (m.meta?.toolCallIds ?? []).map((tid: string) => callsById.get(tid)).filter(Boolean);
            return (
              <div key={m.id} className="col" style={{ gap: 4 }}>
                {showTrace && calls.length > 0 && (
                  <div className="trace-inline"><ITool width={13} /> {calls.map((t: any) => <span key={t.id} className="row" style={{ gap: 4 }}><span className={t.ok ? 'ok-ic' : 'fail-ic'}>{t.ok ? '✓' : '!'}</span><span className="mono">{t.name}</span></span>)}</div>
                )}
                <div className={`msg-row ${out ? 'out' : 'in'} ${m.role === 'human' ? 'human' : ''}`}>
                  <div className={`avatar ${out ? 'ink' : ''}`} style={{ width: 28, height: 28, fontSize: 11 }}>{m.role === 'customer' ? initials(c.customer_name ?? 'V') : m.role === 'human' ? <IUser width={14} /> : <IBot width={14} />}</div>
                  <div style={{ minWidth: 0 }}>
                    <div className="bubble">{m.content}</div>
                    {m.meta?.buttons?.length > 0 && <div className="chips" style={{ justifyContent: out ? 'flex-end' : 'flex-start' }}>{m.meta.buttons.map((b: any) => <span key={b.id} className="chip">{b.label}</span>)}</div>}
                    {m.meta?.payload && <div className="msg-meta"><span className="badge sq">tapped button</span></div>}
                    <div className="msg-meta">
                      <span>{time(m.created_at)}</span>
                      {m.role === 'human' && <span>· {m.meta?.agent ?? 'Agent'}</span>}
                      {m.role === 'agent' && m.meta?.kind && <span className="badge sq">auto · {label(m.meta.kind)}</span>}
                      {m.role === 'agent' && m.meta?.mode && <span className="badge sq">{m.meta.mode === 'llm' ? 'LLM' : m.meta.mode === 'rules' ? 'Rules' : label(m.meta.mode)}{m.meta.llmFallback ? ' (LLM down)' : ''}</span>}
                      {m.meta?.latencyMs != null && <span>{ms(m.meta.latencyMs)}</span>}
                      {m.meta?.grounding?.violations?.length > 0 && <span className="badge solid sq" title={m.meta.grounding.violations.join(', ')}>grounding fixed</span>}
                      {m.meta?.handover && <span className="badge solid sq">handover</span>}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={end} />
        </div>
        {c.status === 'human' ? (
          <div className="composer">
            <textarea className="textarea grow" rows={2} placeholder="Reply to the customer…" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(); }} />
            <button className="btn primary" disabled={!draft.trim() || busy === 'send'} onClick={() => send()}>{busy === 'send' ? <Spinner size={14} /> : <ISend />} Send</button>
          </div>
        ) : (
          <div className="composer-lock">
            {c.status === 'ai' ? <><IBot width={16} /> The AI assistant is handling this chat.</> : c.status === 'needs_human' ? <><IHand width={16} /> Waiting for a person — the AI is paused.</> : <>Resolved. A new customer message reopens it for the AI.</>}
            <button className="btn sm primary" style={{ marginLeft: 'auto' }} disabled={!!busy} onClick={() => act('takeover')}>Take over to reply</button>
          </div>
        )}
      </section>
      <SidePanel conv={c} ticket={ticket} tickets={tickets} toolCalls={toolCalls} orders={orders} llm={llm} messages={messages}
        onUseReply={async (text: string) => { if (c.status !== 'human') await act('takeover'); await send(text); }} />
    </>
  );
}

function SidePanel({ conv, ticket, tickets, toolCalls, orders, llm, messages, onUseReply }: any) {
  const [tab, setTab] = useState<'ticket' | 'trace' | 'context'>(ticket ? 'ticket' : 'trace');
  const [reply, setReply] = useState(ticket?.suggested_reply ?? '');
  const toast = useToast();
  useEffect(() => setReply(ticket?.suggested_reply ?? ''), [ticket?.id, ticket?.suggested_reply]);
  const turns = useMemo(() => {
    const g: { turn: string; calls: any[] }[] = [];
    for (const t of toolCalls) { const last = g[g.length - 1]; if (last?.turn === t.turn_id) last.calls.push(t); else g.push({ turn: t.turn_id, calls: [t] }); }
    return g;
  }, [toolCalls]);
  const customerFor = (turn: string) => {
    const agentMsg = messages.find((m: any) => m.meta?.turnId === turn);
    if (!agentMsg) return null;
    const idx = messages.indexOf(agentMsg);
    for (let i = idx - 1; i >= 0; i--) if (messages[i].role === 'customer') return messages[i].content;
    return null;
  };

  return (
    <aside className="side">
      <div className="side-sec" style={{ paddingBottom: 12 }}>
        <div className="tabs">
          <button className={`tab ${tab === 'ticket' ? 'active' : ''}`} onClick={() => setTab('ticket')}>Handover</button>
          <button className={`tab ${tab === 'trace' ? 'active' : ''}`} onClick={() => setTab('trace')}>Tool calls <span className="n">{toolCalls.length}</span></button>
          <button className={`tab ${tab === 'context' ? 'active' : ''}`} onClick={() => setTab('context')}>Context</button>
        </div>
      </div>
      {tab === 'ticket' && (ticket ? (
        <div className="side-sec col" style={{ gap: 14 }}>
          <div className="row"><span className="mono strong">{ticket.id}</span><span className={`badge ${ticket.priority === 'high' ? 'solid' : ''}`}>{ticket.priority === 'high' ? '▲ High' : 'Normal'}</span><span className={`badge ${ticket.status === 'open' ? '' : 'dashed'}`}>{label(ticket.status)}</span></div>
          <div><div className="section-title">Why it was handed over</div><div className="strong small">{label(ticket.reason_code)}</div><div className="small muted">{ticket.reason}</div></div>
          <div><div className="section-title">Summary</div><div className="small" style={{ whiteSpace: 'pre-wrap' }}>{ticket.summary}</div></div>
          <div className="row"><div className="section-title" style={{ margin: 0 }}>Customer mood</div><span className="badge">{MOOD[ticket.mood] ?? ticket.mood}</span></div>
          <div>
            <div className="section-title">Suggested reply (editable)</div>
            <textarea className="textarea" rows={5} value={reply} onChange={(e) => setReply(e.target.value)} />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn sm primary" disabled={!reply.trim()} onClick={() => onUseReply(reply)}><ISend /> Send as me</button>
              <button className="btn sm" onClick={async () => { await api(`/tickets/${ticket.id}`, { method: 'PATCH', body: { suggested_reply: reply } }); toast('Draft saved'); }}>Save draft</button>
            </div>
          </div>
          {tickets.length > 1 && <div><div className="section-title">Other tickets</div>{tickets.filter((t: any) => t.id !== ticket.id).map((t: any) => <div key={t.id} className="small row"><span className="mono">{t.id}</span><span className="muted">{label(t.reason_code)}</span><span className="badge dashed">{t.status}</span></div>)}</div>}
        </div>
      ) : <Empty title="No handover" icon={<IHand width={18} />}>The AI hasn't handed this chat to a person. Tickets appear here with a summary and a suggested reply.</Empty>)}

      {tab === 'trace' && (
        <div className="side-sec">
          {turns.length === 0 && <Empty title="No tool calls yet" icon={<ITool width={18} />}>Every tool the agent runs — with validated input and output — shows up here.</Empty>}
          {turns.map((g) => (
            <div key={g.turn}>
              <div className="turn-h">{customerFor(g.turn) ? `“${customerFor(g.turn)!.slice(0, 42)}${customerFor(g.turn)!.length > 42 ? '…' : ''}”` : time(g.calls[0].created_at)}</div>
              {g.calls.map((t: any) => (
                <details key={t.id} className="tool">
                  <summary><span className={t.ok ? 'ok-ic' : 'fail-ic'}>{t.ok ? '✓' : '!'}</span><span className="mono strong grow ellipsis">{t.name}</span>{t.actor === 'system' && <span className="badge sq">code</span>}<span className="tiny muted">{ms(t.duration_ms)}</span></summary>
                  <div className="lbl">Input</div><JsonBlock value={t.input} />
                  <div className="lbl">Output{t.error ? ` · ${t.error}` : ''}</div><JsonBlock value={t.output} />
                </details>
              ))}
            </div>
          ))}
          {toolCalls.length > 0 && <p className="tiny muted">Phone numbers and addresses are masked in stored traces. “code” = run by the engine (e.g. verification), not chosen by the model.</p>}
        </div>
      )}

      {tab === 'context' && (
        <div className="side-sec col" style={{ gap: 16 }}>
          <div>
            <div className="section-title">Verification</div>
            <dl className="kv"><dt>Status</dt><dd>{conv.verified_orders.length ? `Verified (${conv.verified_phone})` : 'Not verified'}</dd><dt>Failed attempts</dt><dd>{conv.verify_attempts}</dd><dt>Pending action</dt><dd>{conv.pending_action ? conv.pending_action.summary : '—'}</dd><dt>Active flow</dt><dd>{conv.flow ? label(conv.flow.type) : '—'}</dd></dl>
          </div>
          <div>
            <div className="section-title">Orders in this chat</div>
            {orders.length === 0 ? <div className="small muted">None yet — nothing is shared until the customer is verified.</div> : orders.map((o: any) => (
              <Link key={o.id} to={`/orders/${o.id}`} className="card" style={{ display: 'block', padding: 12, marginBottom: 8, textDecoration: 'none', boxShadow: 'none' }}>
                <div className="row"><span className="mono strong">{o.id}</span><OrderStatus s={o.status} /><IExternal width={13} style={{ marginLeft: 'auto' }} /></div>
                <div className="small muted" style={{ marginTop: 4 }}>{o.items.map((i: any) => `${i.name}${i.size && i.size !== 'ONE' ? ` (${i.size})` : ''}`).join(', ')}</div>
                <div className="small" style={{ marginTop: 4 }}>{o.payment_method.toUpperCase()} · {inr(o.total)}</div>
              </Link>
            ))}
          </div>
          <div>
            <div className="section-title">Signals</div>
            <dl className="kv"><dt>Intents</dt><dd>{[...new Set(conv.intents as string[])].map(label).join(', ') || '—'}</dd><dt>Tool failures</dt><dd>{conv.tool_failures}</dd><dt>Injection tries</dt><dd>{conv.injection_attempts}</dd><dt>First response</dt><dd>{ms(conv.first_response_ms)}</dd><dt>LLM usage</dt><dd>{llm.calls ? `${llm.calls} calls · ${(llm.input + llm.output).toLocaleString()} tokens · $${llm.cost.toFixed(4)}` : 'none (rule-based / flows)'}</dd></dl>
          </div>
          <a className="btn sm" href={`/chat/${conv.id}`} target="_blank" rel="noreferrer"><IExternal /> Open as the customer</a>
        </div>
      )}
      <div className="side-sec tiny muted row"><IRefresh width={12} /> Updates live</div>
    </aside>
  );
}
