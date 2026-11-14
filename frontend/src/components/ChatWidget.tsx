import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { useEventStream } from '../lib/hooks';
import { time } from '../lib/format';
import { IRefresh, ISend, IX } from './icons';

interface Msg { id: string; role: 'customer' | 'agent' | 'human'; content: string; buttons: { id: string; label: string }[]; created_at: string }

const SUGGESTIONS = ['Where is my order?', 'mera order kab aayega?', 'Cancel my order', 'kurta tight hai, L size mil jayega?', 'COD milega Guwahati mein?', "Which size for 5'8, 70kg?"];
const KEY = 'wl_conversation';

function linkify(text: string): ReactNode {
  return text.split(/(https?:\/\/[^\s]+)/g).map((p, i) => /^https?:\/\//.test(p) ? <a key={i} href={p.replace(/[.,)]+$/, '')} target="_blank" rel="noreferrer">{p}</a> : <Fragment key={i}>{p}</Fragment>);
}

export default function ChatWidget({ conversationId, full, onClose }: { conversationId?: string; full?: boolean; onClose?: () => void }) {
  const [id, setId] = useState<string | null>(conversationId ?? null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [status, setStatus] = useState('ai');
  const [text, setText] = useState('');
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  const start = useCallback(async (fresh = false) => {
    setError(null);
    try {
      let cid = conversationId ?? (fresh ? null : localStorage.getItem(KEY));
      if (cid) {
        try { const r = await api<any>(`/chat/${cid}/messages`); setMsgs(r.messages); setStatus(r.status); setId(cid); return; } catch { cid = null; }
      }
      const r = await api<any>('/chat', { body: {} });
      localStorage.setItem(KEY, r.conversationId);
      setId(r.conversationId); setMsgs([]); setStatus('ai');
    } catch (e: any) { setError(e.message); }
  }, [conversationId]);
  useEffect(() => { void start(); }, [start]);

  const connected = useEventStream(id ? `/chat/${id}/stream` : null, (e) => {
    if (e.type === 'status') setStatus(e.status);
    if (e.type === 'message') {
      setMsgs((m) => {
        if (m.some((x) => x.id === e.message.id)) return m;
        const tmp = m.findIndex((x) => x.id.startsWith('tmp') && x.role === e.message.role && x.content === e.message.content);
        if (tmp >= 0) { const n = [...m]; n[tmp] = e.message; return n; }
        return [...m, e.message];
      });
      if (e.message.role !== 'customer') setWaiting(false);
    }
  });
  useEffect(() => { end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [msgs.length, waiting]);

  const send = async (t: string, payload?: string) => {
    if (!id || (!t.trim() && !payload)) return;
    setText(''); setError(null);
    setMsgs((m) => [...m, { id: `tmp${Date.now()}`, role: 'customer', content: t, buttons: [], created_at: new Date().toISOString() }]);
    setWaiting(true);
    try {
      const r = await api<any>(`/chat/${id}/messages`, { body: { text: t, payload, clientMessageId: `c${Date.now()}` } });
      if (r.paused || !r.reply) setWaiting(false);
      const fresh = await api<any>(`/chat/${id}/messages`);
      setMsgs(fresh.messages); setStatus(fresh.status);
    } catch (e: any) { setError(e.message); } finally { setWaiting(false); }
  };

  const last = msgs[msgs.length - 1];
  const paused = status === 'needs_human' || status === 'human';
  return (
    <div className={`widget ${full ? 'full' : ''}`} role="dialog" aria-label="Wishluck support chat">
      <div className="widget-h">
        <div className="avatar">W</div>
        <div className="grow"><div className="strong">Wishluck Support</div><div className="tiny" style={{ opacity: 0.75 }}>{paused ? 'A teammate is joining' : 'AI assistant · replies instantly'} {connected ? '' : '· reconnecting'}</div></div>
        {!conversationId && <button className="btn ghost icon-btn sm" style={{ color: '#fff' }} title="Start a new chat" onClick={() => { localStorage.removeItem(KEY); void start(true); }}><IRefresh /></button>}
        {onClose && <button className="btn ghost icon-btn sm" style={{ color: '#fff' }} aria-label="Close chat" onClick={onClose}><IX /></button>}
      </div>
      <div className="widget-msgs">
        {msgs.length === 0 && !error && (
          <div className="wmsg bot">Hi! I'm Wishluck's support assistant. Ask me about your order, returns, exchanges, refunds, sizes or COD — in English or Hindi. 🙂</div>
        )}
        {msgs.map((m) => (
          <div key={m.id} className="col" style={{ gap: 2 }}>
            <div className={`wmsg ${m.role === 'customer' ? 'me' : m.role === 'human' ? 'human' : 'bot'}`}>{m.role === 'human' && <div className="tiny strong" style={{ marginBottom: 2 }}>Support team</div>}{linkify(m.content)}</div>
            <div className={`tiny faint ${m.role === 'customer' ? '' : ''}`} style={{ alignSelf: m.role === 'customer' ? 'flex-end' : 'flex-start' }}>{time(m.created_at)}</div>
            {m === last && m.role !== 'customer' && m.buttons?.length > 0 && !paused && (
              <div className="wchips">{m.buttons.map((b) => <button key={b.id} className="wchip" onClick={() => send(b.label, b.id)}>{b.label}</button>)}</div>
            )}
          </div>
        ))}
        {waiting && <div className="typing" aria-label="Assistant is typing"><span /><span /><span /></div>}
        {error && <div className="wmsg bot" style={{ borderColor: 'var(--ink)' }}>Couldn't reach support right now ({error}). Please try again.</div>}
        <div ref={end} />
      </div>
      {msgs.length === 0 && <div className="suggest">{SUGGESTIONS.map((s) => <button key={s} onClick={() => send(s)}>{s}</button>)}</div>}
      <form className="widget-in" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        <input className="input" placeholder={paused ? 'Message the support team…' : 'Type a message…'} value={text} onChange={(e) => setText(e.target.value)} aria-label="Message" />
        <button className="btn primary icon-btn" style={{ width: 38, height: 34 }} disabled={!text.trim() || !id} aria-label="Send"><ISend /></button>
      </form>
    </div>
  );
}
