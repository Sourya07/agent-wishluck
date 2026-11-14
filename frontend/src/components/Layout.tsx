import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { IBox, IChart, IExternal, IInbox, ISettings, IStore } from './icons';
import { useApi, useDebounced, useEventStream } from '../lib/hooks';

type Listener = (e: any) => void;
const LiveCtx = createContext<{ subscribe: (l: Listener) => () => void; connected: boolean }>({ subscribe: () => () => {}, connected: false });
export const useLive = () => useContext(LiveCtx);
/** Subscribe to dashboard live events for the lifetime of the component. */
export function useLiveEvent(handler: Listener) {
  const { subscribe } = useLive();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribe((e) => ref.current(e)), [subscribe]);
}

/** One SSE connection for the whole dashboard; pages subscribe to it. */
function LiveProvider({ children }: { children: ReactNode }) {
  const [listeners] = useState(() => new Set<Listener>());
  const connected = useEventStream('/stream', (e) => listeners.forEach((l) => l(e)));
  const [subscribe] = useState(() => (l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; });
  return <LiveCtx.Provider value={{ subscribe, connected }}>{children}</LiveCtx.Provider>;
}

function Sidebar() {
  const { connected } = useLive();
  const { data: convs, reload } = useApi<any[]>('/conversations?status=needs_human');
  const { data: health } = useApi<any>('/health');
  const refetch = useDebounced(() => reload(true), 400);
  useLiveEvent((e) => { if (e.type === 'conversation.updated' || e.type === 'ticket.created') refetch(); });
  const waiting = convs?.length ?? 0;
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">W</div>
        <div><div className="brand-name">Wishluck Ops</div><div className="brand-sub">Order ops & support</div></div>
      </div>
      <nav className="nav">
        <div className="nav-label">Support</div>
        <NavLink to="/inbox"><IInbox /><span>Inbox</span>{waiting > 0 && <b className="count">{waiting}</b>}</NavLink>
        <NavLink to="/orders"><IBox /><span>Orders</span></NavLink>
        <div className="nav-label">Insights</div>
        <NavLink to="/analytics"><IChart /><span>Analytics</span></NavLink>
        <NavLink to="/settings"><ISettings /><span>Settings</span></NavLink>
        <div className="nav-label">Customer view</div>
        <a href="/store" target="_blank" rel="noreferrer"><IStore /><span>Storefront chat</span><IExternal style={{ marginLeft: 'auto', width: 13 }} /></a>
      </nav>
      <div className="sidebar-foot">
        <div className="row"><span className={`live-dot ${connected ? '' : 'off'}`} /><span className="txt">{connected ? 'Live' : 'Reconnecting…'}</span></div>
        {health && <div className="txt tiny">Agent: {health.llm.configured && health.llm.enabled ? `${health.llm.provider} · ${health.llm.model}` : 'rule-based (no LLM key)'}<br />Queue: {health.queue}</div>}
      </div>
    </aside>
  );
}

export default function Layout() {
  return (
    <LiveProvider>
      <div className="shell">
        <Sidebar />
        <main className="main"><Outlet /></main>
      </div>
    </LiveProvider>
  );
}

export function TopBar({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return <header className="topbar"><h1>{title}</h1>{sub && <span className="sub">{sub}</span>}<div className="row" style={{ marginLeft: 'auto' }}>{children}</div></header>;
}
