/**
 * Runs every case in eval/cases.ts against the real app and writes eval/results/report.md (+ .json).
 *   npm run eval                 → uses LLM if LLM_PROVIDER/LLM_API_KEY are set, else the rule-based agent
 *   npm run eval -- --rules      → force rule-based agent
 *   npm run eval -- --only B03   → run a single case
 */
import fs from 'node:fs';
import path from 'node:path';
import { bootHarness } from './harness.js';
import { CASES as MAIN, HELD_OUT, type Check } from './cases.js';
const CASES = [...MAIN, ...HELD_OUT];

const args = process.argv.slice(2);
const forceRules = args.includes('--rules');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1]?.split(',') : null;
if (forceRules) process.env.LLM_PROVIDER = 'none';
const useLlm = !forceRules && !!process.env.LLM_PROVIDER && process.env.LLM_PROVIDER !== 'none';

const h = await bootHarness({ llm: useLlm });
const { config } = h;
const mode = useLlm ? `LLM (${config.llm.provider} / ${config.llm.model})` : 'rule-based fallback agent (no LLM key)';
console.log(`\nRunning ${only ? only.length : CASES.length} cases — ${mode}\n`);

interface Row {
  heldOut: boolean; id: string; appendixB?: number; category: string; title: string; wanted: string; expectedTools: string[]; calledTools: string[]; expectedOutcome: string;
  checks: Check[]; toolsOk: boolean; groundingViolations: string[]; understood: boolean; policyOk: boolean | null; safetyOk: boolean | null;
  pass: boolean; replies: string[]; latencies: number[]; costUsd: number; llmCalls: number; error?: string;
}
const rows: Row[] = [];

for (const cs of CASES.filter((c) => !only || only.includes(c.id))) {
  h.reset();
  const startedLlm = h.db().prepare('SELECT COALESCE(MAX(id),0) m FROM llm_calls').get() as any;
  let run;
  let error: string | undefined;
  try { run = await cs.run(h); } catch (e: any) { error = e.stack ?? e.message; run = { convId: null, checks: [{ name: 'case crashed', kind: 'flow', pass: false, detail: e.message } as Check], replies: [] }; }
  const convIds = run.convId ? [run.convId] : [];
  const called = convIds.flatMap((id) => h.toolCalls(id).map((t: any) => t.name));
  const forbidden = cs.forbiddenTools ?? [];
  const toolsOk = cs.expectedTools.every((t) => called.includes(t)) && (forbidden.includes('*') ? called.length === 0 : forbidden.every((t) => !called.includes(t)));
  // hallucination check: every agent-authored reply must be grounded in tool output / policy / customer text
  const violations: string[] = [];
  const latencies: number[] = [];
  for (const id of convIds) {
    const corpus = h.corpus(id);
    for (const m of h.messages(id)) {
      if (m.role !== 'agent' || m.meta?.kind) continue;
      if (m.meta?.latencyMs != null) latencies.push(m.meta.latencyMs);
      for (const v of h.ungrounded(m.content, corpus)) violations.push(`${v.kind}: ${v.raw}`);
    }
  }
  const llm = h.db().prepare('SELECT COUNT(*) n, COALESCE(SUM(cost_usd),0) cost FROM llm_calls WHERE id>?').get(startedLlm.m) as any;
  const policyChecks = run.checks.filter((c) => c.kind === 'policy');
  const safetyChecks = run.checks.filter((c) => c.kind === 'safety');
  const clarifiedUnexpectedly = cs.id !== 'C37' && run.replies.some((r) => /didn't quite get that|samajh nahi aaya/i.test(r));
  const understood = !error && !clarifiedUnexpectedly && (cs.expectedTools.length ? cs.expectedTools.filter((t) => !t.startsWith('confirmed:')).every((t) => called.includes(t)) : run.checks.filter((c) => c.kind === 'flow').every((c) => c.pass));
  const row: Row = {
    heldOut: cs.id.startsWith('P'), id: cs.id, appendixB: cs.appendixB, category: cs.category, title: cs.title, wanted: cs.wanted, expectedTools: cs.expectedTools, calledTools: [...new Set(called)], expectedOutcome: cs.expectedOutcome,
    checks: run.checks, toolsOk, groundingViolations: violations, understood,
    policyOk: policyChecks.length ? policyChecks.every((c) => c.pass) : null, safetyOk: safetyChecks.length ? safetyChecks.every((c) => c.pass) : null,
    pass: !error && toolsOk && violations.length === 0 && run.checks.every((c) => c.pass), replies: run.replies, latencies, costUsd: llm.cost, llmCalls: llm.n, error,
  };
  rows.push(row);
  const failed = run.checks.filter((c) => !c.pass).map((c) => c.name);
  if (!toolsOk) failed.unshift(`tools (called: ${row.calledTools.join(', ') || 'none'})`);
  if (violations.length) failed.unshift(`ungrounded: ${violations.join('; ')}`);
  console.log(`${row.pass ? 'PASS' : 'FAIL'}  ${cs.id}  ${cs.title}${failed.length ? `\n        ✗ ${failed.join('\n        ✗ ')}` : ''}`);
}

// ------------------------------------------------------------------ summary
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');
const allRows = rows;
const heldRows = allRows.filter((r) => r.heldOut);
rows.splice(0, rows.length, ...allRows.filter((r) => !r.heldOut));
const passed = rows.filter((r) => r.pass).length;
const lat = rows.flatMap((r) => r.latencies);
const avgLat = lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : 0;
const p95 = lat.length ? [...lat].sort((a, b) => a - b)[Math.floor(lat.length * 0.95)] : 0;
const totalCost = rows.reduce((a, r) => a + r.costUsd, 0);
const chatsWithLlm = rows.filter((r) => r.llmCalls > 0).length;
const pol = rows.filter((r) => r.policyOk !== null);
const saf = rows.filter((r) => ['safety', 'verification'].includes(r.category));
const hallucinated = rows.filter((r) => r.groundingViolations.length);

const summary = {
  mode, date: new Date().toISOString(), cases: rows.length, passed,
  understood: rows.filter((r) => r.understood).length, rightTools: rows.filter((r) => r.toolsOk).length,
  policyCorrect: pol.filter((r) => r.policyOk).length, policyCases: pol.length,
  hallucinationCases: hallucinated.length,
  safety: { cases: saf.length, passed: saf.filter((r) => r.pass).length },
  avgLatencyMs: Math.round(avgLat), p95LatencyMs: p95, totalLlmCostUsd: totalCost, avgLlmCostPerChatUsd: chatsWithLlm ? totalCost / chatsWithLlm : 0,
};

const md: string[] = [];
md.push(`# Agent evaluation — ${summary.date.slice(0, 16).replace('T', ' ')} UTC`, '', `**Mode:** ${mode}`, '');
md.push('| Metric | Result |', '|---|---|');
md.push(`| Cases passed (all checks) | **${passed} / ${rows.length}** (${pct(passed, rows.length)}) |`);
md.push(`| Understood the request | ${summary.understood} / ${rows.length} (${pct(summary.understood, rows.length)}) |`);
md.push(`| Called the right tools (and none of the forbidden ones) | ${summary.rightTools} / ${rows.length} (${pct(summary.rightTools, rows.length)}) |`);
md.push(`| Correct policy decision | ${summary.policyCorrect} / ${summary.policyCases} (${pct(summary.policyCorrect, summary.policyCases)}) |`);
md.push(`| Cases with an order detail not from a tool (hallucination = fail) | ${hallucinated.length} |`);
md.push(`| Prompt-injection / data-leak / verification cases passed | ${summary.safety.passed} / ${summary.safety.cases} |`);
md.push(`| Avg agent response time (server-side) | ${Math.round(avgLat)} ms (p95 ${p95} ms) |`);
md.push(`| LLM cost | ${useLlm ? `$${totalCost.toFixed(4)} total, ~$${summary.avgLlmCostPerChatUsd.toFixed(5)} per chat (${rows.reduce((a, r) => a + r.llmCalls, 0)} calls)` : '$0 — no LLM used in this run'} |`);
md.push(`| Paraphrase set P01–P12 (written after the agent; first blind run in heldout-first-run-rules.md) | ${heldRows.filter((r) => r.pass).length} / ${heldRows.length} |`);
md.push('', '## Cases', '', '| # | App. B | Case | Customer wanted | Expected tools | Tools called | Expected outcome | Result |', '|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  md.push(`| ${r.id} | ${r.appendixB ?? ''} | ${r.title} | ${r.wanted} | ${r.expectedTools.join(', ') || '—'} | ${r.calledTools.join(', ') || '—'} | ${r.expectedOutcome} | ${r.pass ? '✅ pass' : '❌ FAIL'} |`);
}
md.push('', '## Held-out paraphrases', '', '| # | Case | Customer said | Tools called | Result |', '|---|---|---|---|---|');
for (const r of heldRows) md.push(`| ${r.id} | ${r.title} | ${r.wanted} | ${r.calledTools.join(', ') || '—'} | ${r.pass ? '✅ pass' : '❌ FAIL'} |`);
const fails = [...rows, ...heldRows].filter((r) => !r.pass);
md.push('', `## Failures (${fails.length})`, '');
if (!fails.length) md.push('None in this run.');
for (const r of fails) {
  md.push(`### ${r.id} — ${r.title}`, '');
  if (!r.toolsOk) md.push(`- Tools: expected ${r.expectedTools.join(', ') || 'none'}${r.id && (CASES.find((c) => c.id === r.id)?.forbiddenTools?.length) ? ` (forbidden: ${CASES.find((c) => c.id === r.id)!.forbiddenTools!.join(', ')})` : ''}; called ${r.calledTools.join(', ') || 'none'}`);
  for (const v of r.groundingViolations) md.push(`- Ungrounded fact in reply: \`${v}\``);
  for (const c of r.checks.filter((x) => !x.pass)) md.push(`- ✗ ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
  if (r.error) md.push('```', r.error.split('\n').slice(0, 4).join('\n'), '```');
  md.push('', 'Transcript (agent replies):', '');
  for (const rep of r.replies) md.push(`> ${rep.replace(/\n/g, ' ')}`, '>');
  md.push('');
}
md.push('', '## Sample replies', '');
for (const r of rows.filter((x) => x.appendixB)) md.push(`**${r.id} ${r.title}**`, '', ...r.replies.filter(Boolean).map((x) => `> ${x.replace(/\n/g, ' ')}\n>`), '');

const outDir = path.resolve(process.cwd(), 'eval/results');
fs.mkdirSync(outDir, { recursive: true });
const tag = useLlm ? 'llm' : 'rules';
fs.writeFileSync(path.join(outDir, `report-${tag}.md`), md.join('\n'));
fs.writeFileSync(path.join(outDir, `results-${tag}.json`), JSON.stringify({ summary, rows, heldOut: heldRows }, null, 2));
console.log(`\nheld-out: ${heldRows.filter((r) => r.pass).length}/${heldRows.length}`);
console.log(`\n${passed}/${rows.length} passed · understood ${summary.understood} · right tools ${summary.rightTools} · policy ${summary.policyCorrect}/${summary.policyCases} · hallucinations ${hallucinated.length} · avg ${Math.round(avgLat)}ms`);
console.log(`Report: eval/results/report-${tag}.md`);
await h.close();
process.exit(0);
