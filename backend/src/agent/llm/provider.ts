/**
 * Provider-agnostic chat + tool-calling client.
 *  - OpenAI-compatible endpoint covers OpenAI, Gemini (OpenAI compat layer), Groq, OpenRouter and Ollama.
 *  - Native Anthropic Messages API.
 * Every call has a hard timeout and retries with backoff (lib/http), and is recorded in llm_calls (tokens, cost, latency).
 */
import { config, llmConfigured } from '../../config.js';
import { getDb, nowIso } from '../../db/index.js';
import { fetchJson } from '../../lib/http.js';
import { getSettings } from '../../settings.js';

export interface ToolCall { id: string; name: string; arguments: string }
export interface ChatMsg { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string; name?: string }
export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }
export interface LlmResult { content: string | null; toolCalls: ToolCall[]; usage: { input: number; output: number }; model: string; latencyMs: number; costUsd: number }

/** USD per 1M tokens [input, output]. Override with LLM_PRICE_IN / LLM_PRICE_OUT. */
const PRICES: [RegExp, number, number][] = [
  [/gpt-4o-mini/, 0.15, 0.6], [/gpt-4\.1-mini/, 0.4, 1.6], [/gpt-4\.1-nano/, 0.1, 0.4], [/gpt-4o/, 2.5, 10], [/gpt-4\.1/, 2, 8], [/gpt-5-mini/, 0.25, 2], [/gpt-5/, 1.25, 10],
  [/claude-3-5-haiku|claude-3-haiku/, 0.8, 4], [/haiku/, 1, 5], [/sonnet/, 3, 15], [/opus-4-[5-9]|opus-5/, 5, 25], [/opus/, 15, 75],
  [/gemini-2\.0-flash-lite/, 0.075, 0.3], [/gemini-2\.[05]-flash/, 0.1, 0.4], [/gemini.*pro/, 1.25, 10],
  [/llama-3\.3-70b/, 0.59, 0.79], [/llama-3\.1-8b/, 0.05, 0.08], [/qwen|llama|mistral/, 0, 0],
];
export function priceFor(model: string): [number, number] {
  if (process.env.LLM_PRICE_IN) return [Number(process.env.LLM_PRICE_IN), Number(process.env.LLM_PRICE_OUT ?? process.env.LLM_PRICE_IN)];
  if (config.llm.provider === 'ollama') return [0, 0];
  const p = PRICES.find(([re]) => re.test(model));
  return p ? [p[1], p[2]] : [0.5, 1.5];
}

export const llmAvailable = () => llmConfigured() && getSettings().agent.llmEnabled;

function record(r: { conversationId?: string | null; purpose: string; model: string; input: number; output: number; cost: number; latency: number; ok: boolean; error?: string }) {
  getDb().prepare(`INSERT INTO llm_calls(conversation_id,provider,model,purpose,input_tokens,output_tokens,cost_usd,latency_ms,ok,error,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(r.conversationId ?? null, config.llm.provider, r.model, r.purpose, r.input, r.output, r.cost, r.latency, r.ok ? 1 : 0, r.error ?? null, nowIso());
}

async function openaiChat(messages: ChatMsg[], tools: ToolSpec[], opts: { temperature: number; maxTokens: number; json?: boolean }) {
  const body: any = {
    model: config.llm.model, temperature: opts.temperature, max_tokens: opts.maxTokens,
    messages: messages.map((m) => {
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content ?? '' };
      if (m.role === 'assistant' && m.tool_calls?.length) return { role: 'assistant', content: m.content ?? null, tool_calls: m.tool_calls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })) };
      return { role: m.role, content: m.content ?? '' };
    }),
  };
  if (tools.length) { body.tools = tools.map((t) => ({ type: 'function', function: t })); body.tool_choice = 'auto'; }
  if (opts.json) body.response_format = { type: 'json_object' };
  const headers: Record<string, string> = {};
  if (config.llm.apiKey) headers.authorization = `Bearer ${config.llm.apiKey}`;
  const data = await fetchJson<any>(`${config.llm.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', body, headers, timeoutMs: config.llm.timeoutMs, retries: config.llm.maxRetries, label: `llm.${config.llm.provider}`,
  });
  const msg = data.choices?.[0]?.message ?? {};
  return {
    content: msg.content ?? null,
    toolCalls: (msg.tool_calls ?? []).map((t: any, i: number) => ({ id: t.id ?? `call_${i}`, name: t.function.name, arguments: typeof t.function.arguments === 'string' ? t.function.arguments : JSON.stringify(t.function.arguments ?? {}) })),
    usage: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 },
    model: data.model ?? config.llm.model,
  };
}

async function anthropicChat(messages: ChatMsg[], tools: ToolSpec[], opts: { temperature: number; maxTokens: number }) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content ?? '' };
      const last = out[out.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content) && last.content.every((c: any) => c.type === 'tool_result')) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    } else if (m.role === 'assistant') {
      const content: any[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const t of m.tool_calls ?? []) content.push({ type: 'tool_use', id: t.id, name: t.name, input: safeParse(t.arguments) });
      out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] });
    } else {
      const last = out[out.length - 1];
      if (last?.role === 'user' && typeof last.content === 'string') last.content += `\n${m.content}`;
      else out.push({ role: 'user', content: m.content ?? '' });
    }
  }
  const body: any = { model: config.llm.model, max_tokens: opts.maxTokens, system, messages: out, tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) };
  if (!noTemperature.has(config.llm.model)) body.temperature = opts.temperature;
  const send = () => fetchJson<any>(`${config.llm.baseUrl.replace(/\/$/, '')}/messages`, {
    method: 'POST', timeoutMs: config.llm.timeoutMs, retries: config.llm.maxRetries, label: 'llm.anthropic',
    headers: { 'x-api-key': config.llm.apiKey, 'anthropic-version': '2023-06-01' }, body,
  });
  let data: any;
  try { data = await send(); } catch (e: any) {
    // Newer models reject `temperature` — drop it and remember for this model.
    if (e?.status === 400 && /temperature/i.test(JSON.stringify(e.body ?? ''))) { noTemperature.add(config.llm.model); delete body.temperature; data = await send(); } else throw e;
  }
  const blocks: any[] = data.content ?? [];
  return {
    content: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n') || null,
    toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) })),
    usage: { input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 },
    model: data.model ?? config.llm.model,
  };
}

const noTemperature = new Set<string>();
const safeParse = (s: string) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

export async function chat(p: { messages: ChatMsg[]; tools?: ToolSpec[]; temperature?: number; maxTokens?: number; json?: boolean; conversationId?: string | null; purpose?: string }): Promise<LlmResult> {
  if (!llmConfigured()) throw new Error('LLM not configured');
  const started = Date.now();
  const opts = { temperature: p.temperature ?? 0.2, maxTokens: p.maxTokens ?? 600, json: p.json };
  try {
    const r = config.llm.provider === 'anthropic' ? await anthropicChat(p.messages, p.tools ?? [], opts) : await openaiChat(p.messages, p.tools ?? [], opts);
    const [pin, pout] = priceFor(r.model);
    const cost = (r.usage.input * pin + r.usage.output * pout) / 1e6;
    const latencyMs = Date.now() - started;
    record({ conversationId: p.conversationId, purpose: p.purpose ?? 'agent', model: r.model, input: r.usage.input, output: r.usage.output, cost, latency: latencyMs, ok: true });
    return { ...r, latencyMs, costUsd: cost };
  } catch (e: any) {
    record({ conversationId: p.conversationId, purpose: p.purpose ?? 'agent', model: config.llm.model, input: 0, output: 0, cost: 0, latency: Date.now() - started, ok: false, error: String(e?.message ?? e).slice(0, 300) });
    throw e;
  }
}
