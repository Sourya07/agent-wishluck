import { useEffect, useState } from 'react';
import { TopBar } from '../components/Layout';
import { ErrorState, Loading, Spinner, Toggle, useToast } from '../components/ui';
import { api } from '../lib/api';
import { label } from '../lib/format';
import { useApi } from '../lib/hooks';

const TIMING_FIELDS: [string, string, string][] = [
  ['codConfirmDelaySec', 'Send COD confirmation after', 'Must be under 60 s'],
  ['codReminderSec', 'Reminder if no reply after', 'Default 2 hours'],
  ['codHoldSec', 'Put order on hold after', 'Default 24 hours'],
  ['ndrReminderSec', 'Failed delivery: reminder after', 'One reminder if the customer is silent'],
  ['ndrEscalateSec', 'Failed delivery: hand over after', 'Only when ≥ 2 attempts failed'],
];
const WEIGHT_HELP: Record<string, string> = {
  highValue: 'Order > ₹2,500', veryHighValue: 'Order > ₹4,000', weakAddress: 'Landmark-only address ("near mandir")', noHouseNumber: 'No house / flat number',
  pincodeRto: 'Pincode refusal rate ≥ 30% (half at ≥ 20%)', newCustomer: 'First order on this phone', repeatCustomerCredit: '≥ 2 delivered, no refusals (negative = less risk)',
  pastRefusal: 'Per earlier refused order (max 2)', codVelocity: 'Other COD orders in last 24 h', suspiciousContact: 'Fake-looking phone / name / email', lateNight: 'Placed 12–5 am IST', remoteZone: 'North East / J&K',
};

const fmtDur = (s: number) => (s >= 3600 ? `${+(s / 3600).toFixed(2)} h` : s >= 60 ? `${+(s / 60).toFixed(1)} min` : `${s} s`);

export default function Settings() {
  const toast = useToast();
  const s = useApi<any>('/settings');
  const health = useApi<any>('/health');
  const [form, setForm] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (s.data) setForm(structuredClone(s.data.settings)); }, [s.data]);
  const dirty = form && s.data && JSON.stringify(form) !== JSON.stringify(s.data.settings);

  const set = (path: string, v: any) => setForm((f: any) => {
    const n = structuredClone(f); const keys = path.split('.'); let o = n;
    for (const k of keys.slice(0, -1)) o = o[k];
    o[keys[keys.length - 1]] = v; return n;
  });
  const save = async (body = form) => {
    setSaving(true);
    try { const r = await api<any>('/settings', { method: 'PUT', body }); s.setData({ ...s.data, settings: r.settings }); toast('Settings saved — applied immediately'); }
    catch (e: any) { toast(e.message, true); } finally { setSaving(false); }
  };

  return (
    <>
      <TopBar title="Settings" sub="Changes apply immediately — no deploy">
        {dirty && <button className="btn sm" onClick={() => setForm(structuredClone(s.data.settings))}>Discard</button>}
        <button className="btn sm primary" disabled={!dirty || saving} onClick={() => save()}>{saving && <Spinner size={13} />} Save changes</button>
      </TopBar>
      <div className="page"><div className="page-narrow col" style={{ gap: 18 }}>
        {s.loading && !form ? <Loading rows={6} /> : s.error ? <ErrorState error={s.error} onRetry={() => s.reload()} /> : form && (
          <>
            <div className="card">
              <div className="card-h"><h3>Reminder & follow-up timings</h3>
                <div className="row" style={{ marginLeft: 'auto' }}>
                  <button className="btn xs" onClick={() => save({ ...form, timings: s.data.fastTimings })}>Use demo timings (seconds)</button>
                  <button className="btn xs" onClick={() => save({ ...form, timings: s.data.defaults.timings })}>Reset to production</button>
                </div>
              </div>
              <div className="card-b set-grid">
                {TIMING_FIELDS.map(([k, l, h]) => (
                  <div className="field" key={k}><label className="label">{l}</label>
                    <div className="row"><input className="input" type="number" min={0} value={form.timings[k]} onChange={(e) => set(`timings.${k}`, Number(e.target.value))} /><span className="small muted" style={{ whiteSpace: 'nowrap' }}>sec</span></div>
                    <div className="hint">{fmtDur(form.timings[k])} · {h}</div></div>
                ))}
              </div>
            </div>

            <div className="card">
              <div className="card-h"><h3>COD risk score</h3><span className="tiny muted" style={{ marginLeft: 'auto' }}>0–100, rules-based, every point is explained on the order</span></div>
              <div className="card-b">
                <div className="set-grid" style={{ marginBottom: 16 }}>
                  <div className="field"><label className="label">Medium risk from</label><input className="input" type="number" value={form.risk.mediumThreshold} onChange={(e) => set('risk.mediumThreshold', Number(e.target.value))} /></div>
                  <div className="field"><label className="label">High risk from</label><input className="input" type="number" value={form.risk.highThreshold} onChange={(e) => set('risk.highThreshold', Number(e.target.value))} /></div>
                  <div className="field"><label className="label">Skip confirmation below</label><input className="input" type="number" value={form.risk.autoConfirmBelow} onChange={(e) => set('risk.autoConfirmBelow', Number(e.target.value))} /><div className="hint">0 = always ask the customer</div></div>
                </div>
                <div className="section-title">Signal weights (points)</div>
                <div className="set-grid">
                  {Object.keys(form.risk.weights).map((k) => (
                    <div className="field" key={k}><label className="label">{label(k.replace(/([A-Z])/g, ' $1').toLowerCase())}</label><input className="input" type="number" value={form.risk.weights[k]} onChange={(e) => set(`risk.weights.${k}`, Number(e.target.value))} /><div className="hint">{WEIGHT_HELP[k]}</div></div>
                  ))}
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-h"><h3>Handover rules</h3></div>
              <div className="card-b">
                <div className="set-grid" style={{ marginBottom: 16 }}>
                  <div className="field"><label className="label">Manual review above (₹)</label><input className="input" type="number" value={form.handover.refundLimit} onChange={(e) => set('handover.refundLimit', Number(e.target.value))} /><div className="hint">Refund or goodwill amount</div></div>
                  <div className="field"><label className="label">Hand over after unresolved turns</label><input className="input" type="number" min={1} value={form.handover.maxUnresolvedTurns} onChange={(e) => set('handover.maxUnresolvedTurns', Number(e.target.value))} /></div>
                  <div className="field"><label className="label">Hand over after tool failures</label><input className="input" type="number" min={1} value={form.handover.maxToolFailures} onChange={(e) => set('handover.maxToolFailures', Number(e.target.value))} /></div>
                  <div className="field"><label className="label">Verification attempts</label><input className="input" type="number" min={1} value={form.handover.maxVerifyAttempts} onChange={(e) => set('handover.maxVerifyAttempts', Number(e.target.value))} /></div>
                </div>
                <div className="set-row"><Toggle on={form.handover.handoverOnInjectionRepeat} onChange={(v) => set('handover.handoverOnInjectionRepeat', v)} label="Injection handover" /><div><div className="strong small">Hand over on repeated manipulation attempts</div><div className="tiny muted">Second "ignore your rules"-style message sends the chat to a person.</div></div></div>
                {(['legalKeywords', 'angerKeywords', 'humanKeywords'] as const).map((k) => (
                  <div className="field" key={k} style={{ marginTop: 12 }}>
                    <label className="label">{k === 'legalKeywords' ? 'Legal / public-complaint phrases' : k === 'angerKeywords' ? 'Upset-customer phrases' : 'Asking-for-a-person phrases'}</label>
                    <textarea className="textarea" rows={2} value={form.handover[k].join(', ')} onChange={(e) => set(`handover.${k}`, e.target.value.split(',').map((x: string) => x.trim()).filter(Boolean))} />
                    <div className="hint">Comma separated, matched on word boundaries (English + Hinglish).</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid2">
              <div className="card"><div className="card-h"><h3>Agent</h3></div><div className="card-b">
                <div className="set-row"><Toggle on={form.agent.llmEnabled} onChange={(v) => set('agent.llmEnabled', v)} label="Use LLM" /><div><div className="strong small">Use the LLM agent</div><div className="tiny muted">{health.data?.llm.configured ? `${health.data.llm.provider} · ${health.data.llm.model}` : 'No LLM key configured — rule-based agent is used'}</div></div></div>
                <div className="set-row"><Toggle on={form.agent.groundingCheck} onChange={(v) => set('agent.groundingCheck', v)} label="Grounding check" /><div><div className="strong small">Grounding check on LLM replies</div><div className="tiny muted">Blocks amounts, dates, IDs or links that didn't come from a tool.</div></div></div>
              </div></div>
              <div className="card"><div className="card-h"><h3>Testing</h3></div><div className="card-b">
                <div className="set-row"><Toggle on={form.simulation.courierOutage} onChange={(v) => set('simulation.courierOutage', v)} label="Courier outage" /><div><div className="strong small">Simulate courier API outage</div><div className="tiny muted">Tracking calls fail → agent offers a callback, then hands over.</div></div></div>
                <div className="set-row"><button className="btn sm" onClick={async () => { if (!confirm('Reset all demo data (orders, chats, tickets)?')) return; await api('/test/reset', { body: {} }); toast('Demo data reset'); }}>Reset demo data</button><span className="tiny muted">Re-seeds Appendix A orders; clears chats & tickets.</span></div>
                <div className="tiny muted" style={{ marginTop: 8 }}>Queue driver: {health.data?.queue ?? '…'} · WhatsApp: {health.data?.whatsapp ? 'connected' : 'not configured'}</div>
              </div></div>
            </div>
          </>
        )}
      </div></div>
    </>
  );
}
