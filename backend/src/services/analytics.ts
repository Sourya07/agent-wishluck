import { getDb, json } from '../db/index.js';
import { HANDOVER_LABELS } from '../agent/handover.js';

const q = <T = any>(sql: string, ...a: any[]) => getDb().prepare(sql).all(...a) as T[];
const one = <T = any>(sql: string, ...a: any[]) => getDb().prepare(sql).get(...a) as T;

export function analytics() {
  const convs = q(`SELECT c.* FROM conversations c WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.role='customer')`);
  const total = convs.length;
  const handed = convs.filter((c) => c.handed_over_ever).length;
  const resolvedByAi = total - handed;

  const handovers = q(`SELECT reason_code, COUNT(*) c FROM tickets WHERE reason_code!='callback' GROUP BY reason_code ORDER BY c DESC`)
    .map((r) => ({ code: r.reason_code, label: (HANDOVER_LABELS as any)[r.reason_code] ?? r.reason_code, count: r.c }));

  const cod = one(`SELECT COUNT(*) total,
      SUM(cod_confirmation='confirmed') confirmed, SUM(cod_confirmation='switched_prepaid') prepaid,
      SUM(cod_confirmation='cancelled') cancelled, SUM(cod_confirmation='on_hold') on_hold, SUM(cod_confirmation='pending') pending,
      SUM(risk_band='high') high, SUM(risk_band='medium') medium, SUM(risk_band='low') low
    FROM orders WHERE cod_confirmation!='not_required' AND source!='seed'`);
  const codAll = one(`SELECT COUNT(*) total, SUM(cod_confirmation IN ('confirmed','switched_prepaid')) ok, SUM(risk_band='high') high, SUM(risk_band='medium') medium, SUM(risk_band='low') low FROM orders WHERE cod_confirmation!='not_required'`);
  const decided = (cod.confirmed ?? 0) + (cod.prepaid ?? 0) + (cod.cancelled ?? 0) + (cod.on_hold ?? 0);

  const ndrSaved = one(`SELECT COUNT(*) c FROM orders WHERE ndr_status IN ('action_taken','delivered_after_ndr')`).c;
  const ndrDelivered = one(`SELECT COUNT(*) c FROM orders WHERE ndr_status='delivered_after_ndr'`).c;
  const prepaidSaved = one(`SELECT COUNT(*) c FROM orders WHERE cod_confirmation='switched_prepaid'`).c;
  const cancelledPreShip = one(`SELECT COUNT(*) c FROM orders WHERE cod_confirmation='cancelled'`).c;
  const ndrOpen = one(`SELECT COUNT(*) c FROM orders WHERE ndr_status='open'`).c;

  const frt = convs.map((c) => c.first_response_ms).filter((x) => x != null).sort((a, b) => a - b);
  const intents: Record<string, number> = {};
  for (const c of convs) for (const i of json<string[]>(c.intents, [])) intents[i] = (intents[i] ?? 0) + 1;

  const llm = one(`SELECT COUNT(*) calls, COALESCE(SUM(input_tokens),0) input, COALESCE(SUM(output_tokens),0) output, COALESCE(SUM(cost_usd),0) cost, AVG(latency_ms) latency, SUM(ok=0) failures, COUNT(DISTINCT conversation_id) convs FROM llm_calls`);
  const agentMsgs = q(`SELECT meta FROM messages WHERE role='agent'`).map((m) => json<any>(m.meta, {})).filter((m) => m.latencyMs != null);
  const modes: Record<string, number> = {};
  for (const m of agentMsgs) modes[m.mode] = (modes[m.mode] ?? 0) + 1;
  const days = q(`SELECT substr(created_at,1,10) d, COUNT(*) c FROM conversations GROUP BY d ORDER BY d DESC LIMIT 14`).reverse();
  const grounding = agentMsgs.filter((m) => m.grounding?.checked);

  return {
    chats: { total, resolvedByAi, handedOver: handed, aiResolutionRate: total ? resolvedByAi / total : 0, open: convs.filter((c) => c.status === 'needs_human').length, byDay: days },
    handovers,
    cod: {
      newOrders: cod.total ?? 0, confirmed: cod.confirmed ?? 0, switchedPrepaid: cod.prepaid ?? 0, cancelled: cod.cancelled ?? 0, onHold: cod.on_hold ?? 0, pending: cod.pending ?? 0,
      confirmationRate: decided ? ((cod.confirmed ?? 0) + (cod.prepaid ?? 0)) / decided : 0,
      riskBands: { low: codAll.low ?? 0, medium: codAll.medium ?? 0, high: codAll.high ?? 0 }, allCodOrders: codAll.total ?? 0,
    },
    rto: { savedTotal: ndrSaved + prepaidSaved + cancelledPreShip, ndrResolved: ndrSaved, ndrDeliveredAfterFollowUp: ndrDelivered, switchedToPrepaid: prepaidSaved, cancelledBeforeDispatch: cancelledPreShip, ndrOpen },
    firstResponse: { avgMs: frt.length ? frt.reduce((a, b) => a + b, 0) / frt.length : null, medianMs: frt.length ? frt[Math.floor(frt.length / 2)] : null, samples: frt.length },
    agentLatency: { avgMs: agentMsgs.length ? agentMsgs.reduce((a, m) => a + m.latencyMs, 0) / agentMsgs.length : null, modes },
    topRequests: Object.entries(intents).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([intent, count]) => ({ intent, count })),
    llm: { calls: llm.calls, inputTokens: llm.input, outputTokens: llm.output, costUsd: llm.cost, avgLatencyMs: llm.latency, failures: llm.failures ?? 0, costPerChatUsd: llm.convs ? llm.cost / llm.convs : 0 },
    grounding: { checked: grounding.length, violations: grounding.filter((g) => g.grounding.violations.length).length, stripped: grounding.filter((g) => g.grounding.stripped).length },
  };
}
