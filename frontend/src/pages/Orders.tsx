import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { TopBar, useLiveEvent } from '../components/Layout';
import { CodBadge, Empty, ErrorState, Loading, OrderStatus, RiskBadge, Spinner, Toggle, useToast } from '../components/ui';
import { IBox, IChat, IExternal, IPlay, IPlus, IRefresh, ISearch, ITruck, IX } from '../components/icons';
import { api } from '../lib/api';
import { ago, dateTime, inr, label } from '../lib/format';
import { useApi, useDebounced } from '../lib/hooks';

const VIEWS = [
  { k: 'all', t: 'All orders', q: '' },
  { k: 'cod', t: 'COD', q: 'payment=cod' },
  { k: 'awaiting', t: 'Awaiting confirmation', q: 'confirmation=pending' },
  { k: 'hold', t: 'On hold', q: 'confirmation=on_hold' },
  { k: 'high', t: 'High risk', q: 'risk=high' },
  { k: 'ndr', t: 'Failed deliveries', q: 'ndr=1' },
  { k: 'rto', t: 'RTO', q: 'status=rto_initiated' },
];

const PRESETS = [
  { k: 'high_risk', t: 'High-risk COD', d: '₹4,600 · "near Shiv mandir" · new customer (Appendix B #7)' },
  { k: 'low_risk', t: 'Low-risk COD', d: 'Repeat customer · full Mumbai address · ₹748' },
  { k: 'repeat_refuser', t: 'COD from a past refuser', d: 'Same phone refused 2 earlier orders' },
  { k: 'prepaid', t: 'Prepaid order', d: 'No confirmation needed — ships straight away' },
];

export default function Orders() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [view, setView] = useState('all');
  const [q, setQ] = useState('');
  const [menu, setMenu] = useState(false);
  const [dup, setDup] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const v = VIEWS.find((x) => x.k === view)!;
  const list = useApi<any[]>(`/orders${v.q ? `?${v.q}` : ''}`, [view]);
  const refetch = useDebounced(() => list.reload(true), 300);
  useLiveEvent((e) => { if (e.type === 'order.updated') refetch(); });

  const rows = useMemo(() => (list.data ?? []).filter((o) => !q || `${o.id} ${o.name} ${o.awb ?? ''} ${o.city ?? ''}`.toLowerCase().includes(q.toLowerCase())), [list.data, q]);

  const create = async (preset: string) => {
    setBusy(preset); setMenu(false);
    try {
      const r = await api<any>('/test/orders', { body: { preset, duplicate: dup } });
      toast(`${r.orderId} created via signed webhook${dup ? ` (sent twice → ${r.duplicateResponse?.duplicate ? 'duplicate ignored' : 'check'})` : ''}`);
      setTimeout(() => nav(`/orders/${r.orderId}`), 500);
    } catch (e: any) { toast(e.message, true); } finally { setBusy(null); }
  };

  return (
    <>
      <TopBar title="Orders" sub="COD risk, confirmations and failed deliveries">
        <button className="btn sm" onClick={async () => { const r = await api<any>('/test/run-jobs', { body: {} }); toast(`Ran ${r.ran} due job(s)`); }} title="Fast-forward: run every queued job now (reminders, holds, follow-ups)"><IPlay /> Run queued jobs</button>
        <div style={{ position: 'relative' }}>
          <button className="btn sm primary" onClick={() => setMenu((m) => !m)} disabled={!!busy}>{busy ? <Spinner size={13} /> : <IPlus />} Create test order</button>
          {menu && (
            <div className="card" style={{ position: 'absolute', right: 0, top: 38, width: 330, zIndex: 20, padding: 6, boxShadow: 'var(--shadow-lg)' }}>
              {PRESETS.map((p) => (
                <button key={p.k} className="btn ghost" style={{ width: '100%', height: 'auto', padding: '9px 10px', justifyContent: 'flex-start', textAlign: 'left', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }} onClick={() => create(p.k)}>
                  <span className="strong">{p.t}</span><span className="tiny muted" style={{ whiteSpace: 'normal' }}>{p.d}</span>
                </button>
              ))}
              <div className="divider" style={{ margin: '6px 0' }} />
              <label className="row small" style={{ padding: '4px 10px 6px' }}><Toggle on={dup} onChange={setDup} label="Send webhook twice" /> Send the webhook twice (idempotency test)</label>
            </div>
          )}
        </div>
      </TopBar>
      <div className="page">
        <div className="toolbar">
          <div className="tabs" style={{ overflowX: 'auto', maxWidth: '100%' }}>{VIEWS.map((x) => <button key={x.k} className={`tab ${view === x.k ? 'active' : ''}`} onClick={() => setView(x.k)}>{x.t}</button>)}</div>
          <div className="row" style={{ position: 'relative', marginLeft: 'auto', width: 260 }}>
            <ISearch width={15} style={{ position: 'absolute', left: 10, color: 'var(--faint)' }} />
            <input className="input" style={{ paddingLeft: 32 }} placeholder="Order, customer, AWB, city" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
        <div className="card" style={{ overflow: 'auto' }}>
          {list.loading && !list.data ? <div className="card-b"><Loading rows={8} /></div>
            : list.error ? <div className="card-b"><ErrorState error={list.error} onRetry={() => list.reload()} /></div>
            : rows.length === 0 ? <Empty title="No orders in this view" icon={<IBox width={20} />}>Use “Create test order” to send a signed order webhook.</Empty>
            : (
              <table className="tbl">
                <thead><tr><th>Order</th><th>Customer</th><th>Payment</th><th style={{ textAlign: 'right' }}>Total</th><th>Status</th><th>COD confirmation</th><th>RTO risk</th><th>Failed attempts</th><th>Placed</th></tr></thead>
                <tbody>
                  {rows.map((o) => (
                    <tr key={o.id} className={`click ${o.id === id ? 'sel' : ''}`} onClick={() => nav(`/orders/${o.id}`)}>
                      <td><span className="mono strong">{o.id}</span>{o.source !== 'seed' && <span className="badge sq" style={{ marginLeft: 6 }}>{o.source}</span>}</td>
                      <td><div>{o.name}</div><div className="tiny muted">{o.city ?? '—'} · {o.pincode}</div></td>
                      <td><span className={`badge ${o.payment_method === 'cod' ? '' : 'soft'}`}>{o.payment_method.toUpperCase()}</span></td>
                      <td style={{ textAlign: 'right' }} className="strong">{inr(o.total)}</td>
                      <td><OrderStatus s={o.status} /></td>
                      <td><CodBadge s={o.cod_confirmation} /></td>
                      <td><RiskBadge band={o.risk_band} score={o.risk_score} /></td>
                      <td>{o.ndr_attempts > 0 ? <span className="badge solid">{o.ndr_attempts}× · {label(o.ndr_status)}</span> : <span className="faint">—</span>}</td>
                      <td className="small muted">{ago(o.created_at)} ago</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
        <p className="tiny muted" style={{ marginTop: 10 }}>{rows.length} orders · phone numbers are masked · new orders arrive through the HMAC-signed <span className="mono">/webhooks/orders</span> endpoint.</p>
      </div>
      {id && <OrderDrawer id={id} onClose={() => nav('/orders')} />}
    </>
  );
}

function OrderDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useToast();
  const d = useApi<any>(`/orders/${id}`);
  const refetch = useDebounced(() => d.reload(true), 200);
  useLiveEvent((e) => { if (e.type === 'order.updated' && e.orderId === id) refetch(); });
  const meta = useApi<any>('/meta');
  const [reason, setReason] = useState('Customer not available');
  const [dup, setDup] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const courierEvent = async (status: string) => {
    setBusy(status);
    try {
      await api(`/test/courier/${id}`, { body: { status, reason: status === 'delivery_failed' ? reason : undefined, duplicate: dup } });
      toast(`Courier sent "${label(status)}"${dup ? ' twice' : ''}`);
      setTimeout(() => d.reload(true), 600);
    } catch (e: any) { toast(e.message, true); } finally { setBusy(null); }
  };
  const opsAction = async (action: string) => {
    setBusy(action);
    try { await api(`/orders/${id}/actions`, { body: { action, agent: 'ops' } }); toast(`${label(action)} done`); await d.reload(true); }
    catch (e: any) { toast(e.message, true); } finally { setBusy(null); }
  };

  const o = d.data?.order;
  return (
    <>
      <div className="drawer-bg" onClick={onClose} />
      <div className="drawer" role="dialog" aria-label={`Order ${id}`}>
        <div className="drawer-h">
          <div className="grow"><div className="row"><span className="mono strong" style={{ fontSize: 16 }}>{id}</span>{o && <OrderStatus s={o.status} />}{o && <span className="badge">{o.payment_method.toUpperCase()}</span>}</div>{o && <div className="small muted">{o.name} · placed {dateTime(o.created_at)}</div>}</div>
          <button className="btn ghost icon-btn" onClick={() => d.reload()} aria-label="Refresh"><IRefresh /></button>
          <button className="btn ghost icon-btn" onClick={onClose} aria-label="Close"><IX /></button>
        </div>
        <div className="drawer-b">
          {d.loading && !d.data ? <Loading rows={6} /> : d.error ? <ErrorState error={d.error} onRetry={() => d.reload()} /> : o && (
            <>
              {o.payment_method === 'cod' || o.cod_confirmation === 'switched_prepaid' ? <RiskCard o={o} onAction={opsAction} busy={busy} /> : null}

              <div className="grid2">
                <div className="card"><div className="card-h"><h3>Items</h3><span className="muted small" style={{ marginLeft: 'auto' }}>{inr(o.total)}</span></div><div className="card-b col" style={{ gap: 6 }}>
                  {o.items.map((i: any) => <div key={i.id} className="row small"><span className="grow">{i.name}{i.size && i.size !== 'ONE' ? ` · ${i.size}` : ''} × {i.qty}</span><span>{inr(i.price * i.qty)}</span></div>)}
                  <div className="divider" style={{ margin: '6px 0' }} />
                  <div className="row small muted"><span className="grow">Shipping / COD fee / discount</span><span>{inr(o.shipping_fee)} / {inr(o.cod_fee)} / −{inr(o.discount)}</span></div>
                </div></div>
                <div className="card"><div className="card-h"><h3>Delivery</h3></div><div className="card-b"><dl className="kv">
                  <dt>Address</dt><dd>{[o.address_line1, o.landmark].filter(Boolean).join(', ')}</dd>
                  <dt>City</dt><dd>{o.city ?? '—'} · {o.pincode}</dd><dt>Phone</dt><dd className="mono">{o.phone}</dd>
                  <dt>ETA</dt><dd>{o.eta_from ? `${dateTime(o.eta_from).split(',')[0]} – ${dateTime(o.eta_to).split(',')[0]}` : '—'}</dd>
                  <dt>AWB</dt><dd>{o.awb ? <a className="mono" href={d.data.trackingUrl} target="_blank" rel="noreferrer">{o.awb} ↗</a> : 'not shipped'}</dd>
                </dl></div></div>
              </div>

              <div className="card">
                <div className="card-h"><ITruck width={16} /><h3>Courier (mock SwiftShip)</h3>{o.ndr_attempts > 0 && <span className="badge solid" style={{ marginLeft: 'auto' }}>{o.ndr_attempts} failed attempt(s) · {label(o.ndr_status)}</span>}</div>
                <div className="card-b col" style={{ gap: 14 }}>
                  {o.ndr_reason && <div className="small"><span className="muted">Last NDR reason:</span> “{o.ndr_reason}”{o.ndr_resolution && <> · <span className="muted">Resolution:</span> {o.ndr_resolution}</>}</div>}
                  <div>
                    <div className="section-title">Trigger a courier event (signed webhook)</div>
                    <div className="row wrap" style={{ gap: 6 }}>
                      {(meta.data?.courierStatuses ?? []).filter((s: string) => s !== 'manifested').map((s: string) => (
                        <button key={s} className={`btn xs ${s === 'delivery_failed' ? 'primary' : ''}`} disabled={!!busy || ['pending_confirmation', 'on_hold', 'cancelled'].includes(o.status)} onClick={() => courierEvent(s)}>{busy === s ? <Spinner size={11} /> : null}{label(s)}</button>
                      ))}
                    </div>
                    <div className="row wrap" style={{ marginTop: 8 }}>
                      <select className="select" style={{ width: 260, height: 30 }} value={reason} onChange={(e) => setReason(e.target.value)}>{(meta.data?.ndrReasons ?? []).map((r: string) => <option key={r}>{r}</option>)}</select>
                      <span className="tiny muted">reason for “Delivery failed”</span>
                      <label className="row tiny" style={{ marginLeft: 'auto' }}><Toggle on={dup} onChange={setDup} label="Send twice" /> send twice</label>
                    </div>
                    {['pending_confirmation', 'on_hold'].includes(o.status) && <div className="hint">Confirm the COD order first — unconfirmed orders don't ship.</div>}
                  </div>
                  {d.data.tracking?.timeline ? (
                    <div className="timeline">
                      {[...d.data.tracking.timeline].reverse().map((t: any, i: number) => (
                        <div key={i} className={`tl ${i === 0 ? 'cur' : ''}`}><div className="row"><span className="strong">{label(t.status)}</span><span className="tiny muted">{dateTime(t.at)}</span></div>{(t.location || t.note) && <div className="small muted">{[t.location, t.note].filter(Boolean).join(' · ')}</div>}</div>
                      ))}
                    </div>
                  ) : d.data.tracking?.error ? <div className="small muted">Courier API unavailable: {d.data.tracking.error}</div> : null}
                </div>
              </div>

              {(d.data.returns?.length > 0 || d.data.refunds?.length > 0) && (
                <div className="card"><div className="card-h"><h3>Returns & refunds</h3></div><div className="card-b col" style={{ gap: 6 }}>
                  {d.data.returns.map((r: any) => <div key={r.id} className="row small"><span className="mono">{r.id}</span><span className="badge">{label(r.type)}</span><span className="badge soft">{label(r.status)}</span>{r.new_size && <span>→ {r.new_size}</span>}<span className="muted" style={{ marginLeft: 'auto' }}>{dateTime(r.created_at)}</span></div>)}
                  {d.data.refunds.map((r: any) => <div key={r.refund_id} className="row small"><span className="mono">{r.refund_id}</span><span>{inr(r.amount)}</span><span className="badge soft">{label(r.status)}</span><span className="muted">{r.method_label}</span></div>)}
                </div></div>
              )}

              {(d.data.conversations.length > 0 || d.data.tickets.length > 0) && (
                <div className="card"><div className="card-h"><IChat width={16} /><h3>Conversations & tickets</h3></div><div className="card-b col" style={{ gap: 6 }}>
                  {d.data.conversations.map((c: any) => <Link key={c.id} to={`/inbox/${c.id}`} className="row small"><span className="mono">{c.id}</span><span className="badge">{label(c.status)}</span><span className="muted">{c.channel}</span><IExternal width={12} style={{ marginLeft: 'auto' }} /></Link>)}
                  {d.data.tickets.map((t: any) => <div key={t.id} className="row small"><span className="mono">{t.id}</span><span>{label(t.reason_code)}</span><span className="badge dashed">{t.status}</span></div>)}
                </div></div>
              )}

              {o.notes?.length > 0 && <div className="card"><div className="card-h"><h3>Notes</h3></div><div className="card-b col" style={{ gap: 6 }}>{o.notes.map((n: any, i: number) => <div key={i} className="small"><span className="muted">{dateTime(n.at)} · {n.by}:</span> {n.text}</div>)}</div></div>}

              <div className="card">
                <div className="card-h"><h3>Audit log</h3><span className="tiny muted" style={{ marginLeft: 'auto' }}>every change: who, when, old → new</span></div>
                <div style={{ maxHeight: 300, overflow: 'auto' }}>
                  <table className="tbl"><thead><tr><th>When</th><th>Field</th><th>Old → New</th><th>By</th></tr></thead><tbody>
                    {d.data.audit.map((a: any) => (
                      <tr key={a.id}><td className="tiny muted" style={{ whiteSpace: 'nowrap' }}>{dateTime(a.created_at)}</td><td className="mono tiny">{a.field}</td>
                        <td className="small"><span className="muted">{trim(a.old_value)}</span> → <span className="strong">{trim(a.new_value)}</span>{a.reason && <div className="tiny muted">{a.reason}</div>}</td>
                        <td><span className={`badge sq ${a.actor === 'agent' ? 'solid' : a.actor.startsWith('human') ? 'dark' : ''}`}>{a.actor}</span></td></tr>
                    ))}
                  </tbody></table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

const trim = (v: string | null) => (v == null ? '∅' : v.length > 60 ? `${v.slice(0, 60)}…` : v);

function RiskCard({ o, onAction, busy }: { o: any; onAction: (a: string) => void; busy: string | null }) {
  const reasons = (o.risk_reasons ?? []) as { signal: string; points: number; detail: string }[];
  return (
    <div className="card">
      <div className="card-h"><h3>COD risk & confirmation</h3><span style={{ marginLeft: 'auto' }}><CodBadge s={o.cod_confirmation} /></span></div>
      <div className="card-b" style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: 20 }}>
        <div className="col" style={{ gap: 6 }}>
          <div className="score-big">{o.risk_score ?? '—'}<span className="muted" style={{ fontSize: 15, fontWeight: 500 }}>/100</span></div>
          <RiskBadge band={o.risk_band} score={o.risk_score} />
          <div className="tiny muted" style={{ marginTop: 6 }}>{o.confirmation_sent_at ? `Asked ${dateTime(o.confirmation_sent_at)}` : 'Not asked yet'}{o.reminder_sent_at ? ` · reminded ${dateTime(o.reminder_sent_at)}` : ''}{o.confirmed_at ? ` · confirmed ${dateTime(o.confirmed_at)}` : ''}</div>
        </div>
        <div>
          <div className="section-title">Why this score</div>
          {reasons.map((r, i) => <div key={i} className="reason"><span className="pts">{r.points > 0 ? `+${r.points}` : r.points}</span><span>{r.detail}</span></div>)}
        </div>
      </div>
      <div className="card-b row wrap" style={{ borderTop: '1px solid var(--line)', gap: 6 }}>
        <span className="tiny muted grow">Ops actions</span>
        <button className="btn xs" disabled={!!busy} onClick={() => onAction('resend_confirmation')}>Re-send confirmation</button>
        {['pending', 'on_hold'].includes(o.cod_confirmation) && <button className="btn xs primary" disabled={!!busy} onClick={() => onAction('confirm')}>Mark confirmed</button>}
        {o.cod_confirmation === 'on_hold' && <button className="btn xs" disabled={!!busy} onClick={() => onAction('release_hold')}>Release hold</button>}
        {['pending', 'on_hold', 'confirmed'].includes(o.cod_confirmation) && !o.awb && <button className="btn xs" disabled={!!busy} onClick={() => onAction('cancel')}>Cancel order</button>}
      </div>
    </div>
  );
}
