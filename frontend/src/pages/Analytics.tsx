import { TopBar, useLiveEvent } from '../components/Layout';
import { Empty, ErrorState, Loading } from '../components/ui';
import { IChart, IRefresh } from '../components/icons';
import { label, ms, pct } from '../lib/format';
import { useApi, useDebounced } from '../lib/hooks';
import { useState } from 'react';

function Kpi({ l, v, s }: { l: string; v: string; s?: string }) {
  return <div className="card kpi"><div className="l">{l}</div><div className="v">{v}</div>{s && <div className="s">{s}</div>}</div>;
}

/** Single-series horizontal bars: one ink colour, value labels, hover tooltip. */
function HBars({ data, unit = '' }: { data: { label: string; value: number; tip?: string }[]; unit?: string }) {
  if (!data.length) return <Empty title="No data yet" icon={<IChart width={18} />}>This fills in as chats and orders come in.</Empty>;
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div role="list">
      {data.map((d) => (
        <div key={d.label} className="hbar" role="listitem" aria-label={`${d.label}: ${d.value}${unit}`}>
          <span className="ellipsis">{d.label}</span>
          <span className="track"><span className="fill" style={{ width: `${(d.value / max) * 100}%` }} /></span>
          <span className="val">{d.value}{unit}</span>
          <span className="tip">{d.tip ?? `${d.label}: ${d.value}${unit}`}</span>
        </div>
      ))}
    </div>
  );
}

function Columns({ data }: { data: { label: string; value: number }[] }) {
  if (!data.length) return <Empty title="No chats yet" icon={<IChart width={18} />} />;
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <>
      <div className="cols">{data.map((d) => <div key={d.label} className="c"><span className="tip">{d.label}: {d.value} chats</span><div className="b" style={{ height: `${(d.value / max) * 100}%` }} /></div>)}</div>
      <div className="cols-x">{data.map((d) => <span key={d.label}>{d.label.slice(5)}</span>)}</div>
    </>
  );
}

export default function Analytics() {
  const a = useApi<any>('/analytics');
  const calls = useApi<any[]>('/llm-calls');
  const refetch = useDebounced(() => { a.reload(true); calls.reload(true); }, 1500);
  useLiveEvent(() => refetch());
  const [table, setTable] = useState(false);

  return (
    <>
      <TopBar title="Analytics" sub="Live from the database"><button className="btn sm" onClick={() => { a.reload(); calls.reload(); }}><IRefresh /> Refresh</button></TopBar>
      <div className="page">
        {a.loading && !a.data ? <Loading rows={6} /> : a.error ? <ErrorState error={a.error} onRetry={() => a.reload()} /> : a.data && (() => {
          const d = a.data;
          return (
            <div className="col" style={{ gap: 18 }}>
              <div className="grid5">
                <Kpi l="Chats solved without a person" v={pct(d.chats.aiResolutionRate)} s={`${d.chats.resolvedByAi} of ${d.chats.total} chats`} />
                <Kpi l="COD confirmation rate" v={pct(d.cod.confirmationRate)} s={`${d.cod.confirmed} confirmed · ${d.cod.switchedPrepaid} prepaid · ${d.cod.cancelled} cancelled · ${d.cod.onHold} on hold`} />
                <Kpi l="Orders saved from RTO" v={String(d.rto.savedTotal)} s={`${d.rto.switchedToPrepaid} → prepaid · ${d.rto.ndrResolved} NDR fixed · ${d.rto.cancelledBeforeDispatch} cancelled pre-ship`} />
                <Kpi l="First response time" v={ms(d.firstResponse.medianMs)} s={`median · avg ${ms(d.firstResponse.avgMs)} · ${d.firstResponse.samples} chats`} />
                <Kpi l="LLM cost per chat" v={d.llm.calls ? `$${d.llm.costPerChatUsd.toFixed(4)}` : '$0'} s={d.llm.calls ? `$${d.llm.costUsd.toFixed(3)} total · ${d.llm.calls} calls` : 'rule-based agent / no LLM calls'} />
              </div>

              <div className="grid2">
                <div className="card"><div className="card-h"><h3>Handovers by reason</h3><span className="tiny muted" style={{ marginLeft: 'auto' }}>{d.chats.handedOver} chats handed over</span></div><div className="card-b">
                  <HBars data={d.handovers.map((h: any) => ({ label: h.label, value: h.count }))} />
                </div></div>
                <div className="card"><div className="card-h"><h3>Most common requests</h3><span className="tiny muted" style={{ marginLeft: 'auto' }}>by detected intent</span></div><div className="card-b">
                  <HBars data={d.topRequests.map((r: any) => ({ label: label(r.intent), value: r.count }))} />
                </div></div>
              </div>

              <div className="grid3">
                <div className="card"><div className="card-h"><h3>New COD orders → outcome</h3></div><div className="card-b">
                  <HBars data={[
                    { label: 'Confirmed', value: d.cod.confirmed }, { label: 'Switched to prepaid', value: d.cod.switchedPrepaid },
                    { label: 'Cancelled pre-ship', value: d.cod.cancelled }, { label: 'On hold (no reply)', value: d.cod.onHold }, { label: 'Awaiting reply', value: d.cod.pending },
                  ]} />
                  <p className="tiny muted">Orders that arrived via webhook ({d.cod.newOrders}). Seed data excluded.</p>
                </div></div>
                <div className="card"><div className="card-h"><h3>COD orders by RTO risk</h3></div><div className="card-b">
                  <HBars data={[{ label: '▲ High', value: d.cod.riskBands.high }, { label: '◆ Medium', value: d.cod.riskBands.medium }, { label: '▽ Low', value: d.cod.riskBands.low }]} />
                  <p className="tiny muted">All {d.cod.allCodOrders} COD orders incl. seed.</p>
                </div></div>
                <div className="card"><div className="card-h"><h3>Failed deliveries</h3></div><div className="card-b">
                  <HBars data={[{ label: 'Fixed after follow-up', value: d.rto.ndrResolved }, { label: 'Delivered after NDR', value: d.rto.ndrDeliveredAfterFollowUp }, { label: 'Still open', value: d.rto.ndrOpen }]} />
                </div></div>
              </div>

              <div className="grid2">
                <div className="card"><div className="card-h"><h3>Chats per day</h3></div><div className="card-b"><Columns data={d.chats.byDay.map((x: any) => ({ label: x.d, value: x.c }))} /></div></div>
                <div className="card"><div className="card-h"><h3>Agent quality & speed</h3></div><div className="card-b">
                  <dl className="kv">
                    <dt>Avg reply time</dt><dd>{ms(d.agentLatency.avgMs)} (server-side)</dd>
                    <dt>Replies by engine</dt><dd>{Object.entries(d.agentLatency.modes).map(([k, v]) => `${label(k)} ${v}`).join(' · ') || '—'}</dd>
                    <dt>Grounding checks</dt><dd>{d.grounding.checked} LLM replies checked · {d.grounding.violations} had an unsupported fact · {d.grounding.stripped} needed stripping</dd>
                    <dt>Open handovers</dt><dd>{d.chats.open}</dd>
                  </dl>
                </div></div>
              </div>

              <div className="card">
                <div className="card-h"><h3>LLM usage & cost</h3><button className="btn xs" style={{ marginLeft: 'auto' }} onClick={() => setTable((t) => !t)}>{table ? 'Hide' : 'Show'} recent calls</button></div>
                <div className="card-b">
                  <div className="grid4">
                    <div><div className="tiny muted">Calls</div><div className="strong">{d.llm.calls} {d.llm.failures ? <span className="muted">({d.llm.failures} failed)</span> : null}</div></div>
                    <div><div className="tiny muted">Tokens in / out</div><div className="strong">{d.llm.inputTokens.toLocaleString()} / {d.llm.outputTokens.toLocaleString()}</div></div>
                    <div><div className="tiny muted">Total cost</div><div className="strong">${d.llm.costUsd.toFixed(4)}</div></div>
                    <div><div className="tiny muted">Avg LLM latency</div><div className="strong">{ms(d.llm.avgLatencyMs)}</div></div>
                  </div>
                  {table && (calls.data?.length ? (
                    <div style={{ marginTop: 14, maxHeight: 320, overflow: 'auto' }}><table className="tbl"><thead><tr><th>When</th><th>Model</th><th>Purpose</th><th>Tokens</th><th>Cost</th><th>Latency</th><th>OK</th></tr></thead><tbody>
                      {calls.data.map((c) => <tr key={c.id}><td className="tiny">{new Date(c.created_at).toLocaleTimeString()}</td><td className="mono tiny">{c.model}</td><td>{label(c.purpose)}</td><td>{c.input_tokens}/{c.output_tokens}</td><td>${(c.cost_usd ?? 0).toFixed(5)}</td><td>{ms(c.latency_ms)}</td><td>{c.ok ? '✓' : `✕ ${c.error ?? ''}`}</td></tr>)}
                    </tbody></table></div>
                  ) : <p className="small muted" style={{ marginTop: 12 }}>No LLM calls recorded. Set LLM_PROVIDER and LLM_API_KEY to use the model-backed agent.</p>)}
                </div>
              </div>
            </div>
          );
        })()}
      </div>
    </>
  );
}
