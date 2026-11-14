/**
 * Job queue with two interchangeable drivers:
 *  - BullMQ (Redis)   — used when REDIS_URL is set (Docker setup uses this).
 *  - SQLite           — durable fallback so `npm run dev` works with zero infrastructure.
 * Both support delayed jobs, retries with exponential backoff and de-duplication by job key,
 * which is what makes duplicate webhooks harmless.
 */
import { Queue as BullQueue, Worker as BullWorker } from 'bullmq';
import { getDb, nowIso } from '../db/index.js';
import { config } from '../config.js';
import { log } from '../lib/logger.js';

export type JobHandler = (data: any) => Promise<void>;
export interface AddOpts { delayMs?: number; key?: string; attempts?: number }

export interface JobQueue {
  driver: 'bullmq' | 'sqlite';
  add(type: string, data: unknown, opts?: AddOpts): Promise<boolean>;
  start(handlers: Record<string, JobHandler>): void;
  stop(): Promise<void>;
  /** For tests/eval: run every job that is due now (sqlite driver). */
  drain?(opts?: { includeDelayed?: boolean; types?: string[] }): Promise<number>;
  stats(): Promise<Record<string, number>>;
}

class SqliteQueue implements JobQueue {
  driver = 'sqlite' as const;
  private timer: NodeJS.Timeout | null = null;
  private handlers: Record<string, JobHandler> = {};
  private running = false;

  async add(type: string, data: unknown, opts: AddOpts = {}) {
    const r = getDb().prepare(`INSERT OR IGNORE INTO jobs(job_key,type,payload,run_at,max_attempts,created_at) VALUES (?,?,?,?,?,?)`)
      .run(opts.key ?? null, type, JSON.stringify(data ?? {}), Date.now() + (opts.delayMs ?? 0), opts.attempts ?? 5, nowIso());
    if (r.changes === 0) log.info('job deduplicated', { type, key: opts.key });
    return r.changes > 0;
  }

  start(handlers: Record<string, JobHandler>) {
    this.handlers = handlers;
    this.timer = setInterval(() => void this.tick(), 400);
  }

  private async runJob(j: any) {
    const h = this.handlers[j.type];
    const db = getDb();
    db.prepare(`UPDATE jobs SET status='running', attempts=attempts+1 WHERE id=?`).run(j.id);
    try {
      if (!h) throw new Error(`No handler for ${j.type}`);
      await h(JSON.parse(j.payload));
      db.prepare(`UPDATE jobs SET status='done', finished_at=? WHERE id=?`).run(nowIso(), j.id);
    } catch (e: any) {
      const attempts = j.attempts + 1;
      const failed = attempts >= j.max_attempts;
      const backoff = 1000 * 2 ** attempts;
      db.prepare(`UPDATE jobs SET status=?, run_at=?, last_error=? WHERE id=?`).run(failed ? 'failed' : 'queued', Date.now() + backoff, String(e?.message ?? e), j.id);
      log.error('job failed', { type: j.type, attempts, willRetry: !failed, error: String(e?.message ?? e) });
    }
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const due = getDb().prepare(`SELECT * FROM jobs WHERE status='queued' AND run_at<=? ORDER BY run_at LIMIT 20`).all(Date.now()) as any[];
      for (const j of due) await this.runJob(j);
    } finally { this.running = false; }
  }

  async drain(opts: { includeDelayed?: boolean; types?: string[] } = {}) {
    let n = 0;
    for (let i = 0; i < 50; i++) {
      const rows = (getDb().prepare(`SELECT * FROM jobs WHERE status='queued' ${opts.includeDelayed ? '' : 'AND run_at<=?'} ORDER BY run_at LIMIT 50`)
        .all(...(opts.includeDelayed ? [] : [Date.now()])) as any[]).filter((j) => !opts.types || opts.types.includes(j.type));
      if (!rows.length) break;
      for (const j of rows) { await this.runJob(j); n++; }
    }
    return n;
  }

  async stop() { if (this.timer) clearInterval(this.timer); }

  async stats() {
    const rows = getDb().prepare(`SELECT status, COUNT(*) c FROM jobs GROUP BY status`).all() as any[];
    return Object.fromEntries(rows.map((r) => [r.status, r.c]));
  }
}

class BullMqQueue implements JobQueue {
  driver = 'bullmq' as const;
  private q: BullQueue;
  private worker: BullWorker | null = null;
  private connection: any;
  constructor(url: string) {
    const u = new URL(url);
    this.connection = { host: u.hostname, port: Number(u.port || 6379), password: u.password || undefined, username: u.username || undefined, maxRetriesPerRequest: null };
    this.q = new BullQueue('wishluck-ops', { connection: this.connection });
  }
  async add(type: string, data: unknown, opts: AddOpts = {}) {
    // BullMQ ignores a job whose jobId already exists → natural de-duplication.
    const jobId = opts.key ? opts.key.replace(/:/g, '__') : undefined;
    if (jobId && (await this.q.getJob(jobId))) { log.info('job deduplicated', { type, key: opts.key }); return false; }
    await this.q.add(type, data, {
      jobId, delay: opts.delayMs ?? 0, attempts: opts.attempts ?? 5,
      backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: { age: 7 * 86400 }, removeOnFail: { age: 30 * 86400 },
    });
    return true;
  }
  start(handlers: Record<string, JobHandler>) {
    this.worker = new BullWorker('wishluck-ops', async (job) => {
      const h = handlers[job.name];
      if (!h) throw new Error(`No handler for ${job.name}`);
      await h(job.data);
    }, { connection: this.connection, concurrency: 5 });
    this.worker.on('failed', (job, err) => log.error('job failed', { type: job?.name, attempts: job?.attemptsMade, error: err.message }));
  }
  async stop() { await this.worker?.close(); await this.q.close(); }
  async stats() { return (await this.q.getJobCounts()) as Record<string, number>; }
}

let instance: JobQueue | null = null;
export function getQueue(): JobQueue {
  if (instance) return instance;
  instance = config.redisUrl ? new BullMqQueue(config.redisUrl) : new SqliteQueue();
  log.info('queue driver', { driver: instance.driver });
  return instance;
}
/** Tests use the in-process driver regardless of env. */
export function useSqliteQueue() { instance = new SqliteQueue(); return instance; }
