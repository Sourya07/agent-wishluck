import { config, llmConfigured } from './config.js';
import { getDb } from './db/index.js';
import { createApp } from './app.js';
import { getQueue } from './queue/index.js';
import { jobHandlers } from './queue/jobs.js';
import { seed } from './services/seed.js';
import { log } from './lib/logger.js';

getDb();
const count = (getDb().prepare('SELECT COUNT(*) c FROM orders').get() as { c: number }).c;
if (count === 0 || process.env.SEED_ON_START === 'true') {
  const r = seed({ reset: true });
  log.info('database seeded', r);
}

const queue = getQueue();
queue.start(jobHandlers);

const server = createApp().listen(config.port, () => {
  log.info('wishluck ops backend listening', {
    port: config.port, queue: queue.driver, llm: llmConfigured() ? `${config.llm.provider}/${config.llm.model}` : 'not configured (rule-based agent)',
    whatsapp: config.whatsapp.enabled, frontend: config.frontendUrl,
  });
});

const shutdown = async () => { server.close(); await queue.stop(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
