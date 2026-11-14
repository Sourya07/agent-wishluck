/**
 * Test harness: boots the real app (HTTP server, mock courier, webhooks, SQLite queue) on a private port
 * with a throwaway database, so every case exercises the same code paths as production.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export async function bootHarness(opts: { port?: number; llm?: boolean } = {}) {
  const port = opts.port ?? 4555;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-eval-'));
  process.env.DB_PATH = path.join(dir, 'eval.db');
  process.env.PORT = String(port);
  process.env.REDIS_URL = '';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
  if (!opts.llm) process.env.LLM_PROVIDER = process.env.LLM_PROVIDER ?? 'none';

  const { createApp } = await import('../src/app.js');
  const { useSqliteQueue } = await import('../src/queue/index.js');
  const { jobHandlers } = await import('../src/queue/jobs.js');
  const { seed } = await import('../src/services/seed.js');
  const { updateSettings, FAST_TIMINGS } = await import('../src/settings.js');
  const engine = await import('../src/agent/engine.js');
  const convs = await import('../src/services/conversations.js');
  const orders = await import('../src/services/orders.js');
  const { getDb } = await import('../src/db/index.js');
  const { postSignedOrderWebhook } = await import('../src/routes/api.js');
  const { courier } = await import('../src/services/courierClient.js');
  const { buildCorpus, ungrounded } = await import('../src/agent/grounding.js');
  const { POLICY_TEXT } = await import('../src/policy/policyDoc.js');
  const { config } = await import('../src/config.js');

  const queue = useSqliteQueue();
  queue.start(jobHandlers, { poll: false }); // jobs are drained manually → deterministic runs

  const server = await new Promise<any>((res) => { const s = createApp().listen(port, () => res(s)); });

  const h = {
    config,
    reset() {
      seed({ reset: true });
      updateSettings({ timings: { ...FAST_TIMINGS, codConfirmDelaySec: 0 }, simulation: { courierOutage: false }, agent: { llmEnabled: !!opts.llm, groundingCheck: true } });
    },
    settings: updateSettings,
    newConversation: () => convs.createConversation({ channel: 'web' }).id,
    async say(conversationId: string, input: string | { text?: string; payload?: string }) {
      const t = typeof input === 'string' ? { text: input } : input;
      return engine.handleCustomerMessage(conversationId, t.text ?? '', { payload: t.payload });
    },
    drain: (includeDelayed = false) => queue.drain!({ includeDelayed }),
    order: (id: string) => orders.getOrder(id)!,
    conv: (id: string) => convs.getConversation(id)!,
    messages: (id: string) => convs.getMessages(id),
    toolCalls: (id: string) => convs.getToolCalls(id),
    tickets: (convId: string) => getDb().prepare('SELECT * FROM tickets WHERE conversation_id=?').all(convId) as any[],
    returnsFor: (orderId: string) => getDb().prepare('SELECT * FROM returns WHERE order_id=?').all(orderId) as any[],
    refundsFor: (orderId: string) => getDb().prepare('SELECT * FROM refunds WHERE order_id=?').all(orderId) as any[],
    conversationsForPhone: (phone: string) => getDb().prepare('SELECT id FROM conversations WHERE customer_phone=?').all(phone).map((r: any) => r.id) as string[],
    db: getDb,
    async createOrder(payload: any, duplicate = false) {
      const out = await postSignedOrderWebhook(payload, { duplicate });
      await h.drain();
      return out;
    },
    async courierEvent(orderId: string, status: string, reason?: string, duplicate = false) {
      const o = orders.getOrder(orderId)!;
      await courier.event(o.awb!, { status, reason, duplicate });
      await h.drain();
    },
    /** Facts the agent was allowed to state in a conversation. */
    corpus(convId: string) {
      const tc = convs.getToolCalls(convId).map((c) => JSON.stringify(c.output));
      const msgs = convs.getMessages(convId).filter((m) => m.role === 'customer' || m.meta?.kind).map((m) => m.content);
      return buildCorpus([...tc, ...msgs, POLICY_TEXT, config.frontendUrl]);
    },
    ungrounded,
    async close() { server.close(); },
  };
  return h;
}
export type Harness = Awaited<ReturnType<typeof bootHarness>>;
