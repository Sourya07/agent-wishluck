import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { IAlert, IRefresh } from './icons';
import { label } from '../lib/format';

export function Spinner({ size = 16 }: { size?: number }) { return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />; }

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return <div className="empty"><div className="glyph">{icon ?? '∅'}</div><h4>{title}</h4>{children && <p>{children}</p>}</div>;
}

export function ErrorState({ error, onRetry }: { error: Error | string; onRetry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      <IAlert width={18} height={18} />
      <div className="grow">
        <div className="strong">Couldn't load this</div>
        <div className="small muted">{typeof error === 'string' ? error : error.message}. Is the backend running on port 4000?</div>
      </div>
      {onRetry && <button className="btn sm" onClick={onRetry}><IRefresh /> Retry</button>}
    </div>
  );
}

export function Loading({ rows = 4 }: { rows?: number }) {
  return <div className="col" style={{ gap: 10 }}>{Array.from({ length: rows }).map((_, i) => <div key={i} className="skeleton" style={{ height: 44 }} />)}</div>;
}

export function Toggle({ on, onChange, label: l }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={l} className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />;
}

/* ---- domain badges: meaning via fill/weight/icon, never colour */
const CONV: Record<string, { cls: string; text: string; icon: string }> = {
  ai: { cls: '', text: 'AI handling', icon: '◇' },
  needs_human: { cls: 'solid', text: 'Needs a person', icon: '●' },
  human: { cls: 'dark', text: 'Human handling', icon: '◆' },
  resolved: { cls: 'dashed', text: 'Resolved', icon: '✓' },
};
export function ConvStatus({ s }: { s: string }) { const c = CONV[s] ?? { cls: '', text: label(s), icon: '' }; return <span className={`badge ${c.cls}`}>{c.icon} {c.text}</span>; }

export function RiskBadge({ band, score }: { band?: string | null; score?: number | null }) {
  if (!band) return <span className="faint">—</span>;
  return (
    <span className="risk" title={`Risk score ${score}/100`}>
      <span className={`risk-bar ${band}`}><span style={{ width: `${score ?? 0}%` }} /></span>
      <span className={`badge sq ${band === 'high' ? 'solid' : band === 'medium' ? 'soft' : ''}`}>{band === 'high' ? '▲' : band === 'medium' ? '◆' : '▽'} {score}</span>
    </span>
  );
}

const ORDER_STATUS: Record<string, string> = { delivered: 'soft', cancelled: 'dashed', delivery_failed: 'solid', on_hold: 'solid', rto_initiated: 'dark', rto_delivered: 'dark', pending_confirmation: '' };
export function OrderStatus({ s }: { s: string }) { return <span className={`badge ${ORDER_STATUS[s] ?? ''}`}>{s === 'delivery_failed' ? '! ' : ''}{label(s)}</span>; }

const COD: Record<string, string> = { pending: 'Awaiting reply', confirmed: 'Confirmed', cancelled: 'Cancelled', on_hold: 'On hold', switched_prepaid: 'Switched to prepaid', not_required: '—' };
export function CodBadge({ s }: { s: string }) {
  if (s === 'not_required') return <span className="faint">—</span>;
  const cls = s === 'on_hold' ? 'solid' : s === 'switched_prepaid' ? 'dark' : s === 'pending' ? 'dashed' : s === 'cancelled' ? 'dashed' : 'soft';
  return <span className={`badge ${cls}`}>{s === 'confirmed' || s === 'switched_prepaid' ? '✓ ' : s === 'pending' ? '… ' : ''}{COD[s] ?? label(s)}</span>;
}

export const MOOD: Record<string, string> = { angry: '😠 Angry', frustrated: '😕 Frustrated', neutral: '😐 Neutral', positive: '🙂 Positive' };

/* ---- toasts */
interface T { id: number; text: string; err?: boolean }
const Ctx = createContext<(text: string, err?: boolean) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<T[]>([]);
  const push = useCallback((text: string, err?: boolean) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, err }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 3200);
  }, []);
  return <Ctx.Provider value={push}>{children}<div className="toasts">{items.map((t) => <div key={t.id} className={`toast ${t.err ? 'err' : ''}`}>{t.err ? '✕' : '✓'} {t.text}</div>)}</div></Ctx.Provider>;
}
export const useToast = () => useContext(Ctx);

export function JsonBlock({ value }: { value: unknown }) {
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}
