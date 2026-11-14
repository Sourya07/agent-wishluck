/** Anthropic Messages API adapter: request shape (system, tool_use / tool_result blocks) and response parsing. */
import http from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';

const bodies: any[] = [];
const server = http.createServer((req, res) => {
  let d = ''; req.on('data', (c) => (d += c));
  req.on('end', () => {
    bodies.push({ headers: req.headers, body: JSON.parse(d) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'claude-3-5-haiku-latest', content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'tu_1', name: 'check_pincode', input: { pincode: '795001' } }], usage: { input_tokens: 900, output_tokens: 40 } }));
  });
});
await new Promise<void>((r) => server.listen(0, r));
process.env.LLM_PROVIDER = 'anthropic';
process.env.LLM_API_KEY = 'sk-ant-test';
process.env.LLM_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}/v1`;
const { chat } = await import('../src/agent/llm/provider.js');
afterAll(() => server.close());

describe('anthropic adapter', () => {
  it('maps messages/tools and parses tool_use', async () => {
    const r = await chat({
      messages: [
        { role: 'system', content: 'sys A' }, { role: 'system', content: 'sys B' },
        { role: 'user', content: 'COD to 795001?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 't1', name: 'get_policy', arguments: '{"topic":"cod"}' }, { id: 't2', name: 'check_pincode', arguments: '{"pincode":"795001"}' }] },
        { role: 'tool', tool_call_id: 't1', content: '{"ok":true}' }, { role: 'tool', tool_call_id: 't2', content: '{"ok":true}' },
      ],
      tools: [{ name: 'check_pincode', description: 'd', parameters: { type: 'object', properties: { pincode: { type: 'string' } } } }],
    });
    const { headers, body } = bodies[0];
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(body.system).toBe('sys A\n\nsys B');
    expect(body.messages[1].content.map((c: any) => c.type)).toEqual(['tool_use', 'tool_use']);
    expect(body.messages[2].content.map((c: any) => c.tool_use_id)).toEqual(['t1', 't2']); // both results in one user turn
    expect(body.tools[0].input_schema.type).toBe('object');
    expect(r.toolCalls).toEqual([{ id: 'tu_1', name: 'check_pincode', arguments: '{"pincode":"795001"}' }]);
    expect(r.content).toBe('Checking.');
    expect(r.costUsd).toBeCloseTo((900 * 0.8 + 40 * 4) / 1e6, 9);
  });
});
