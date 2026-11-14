// node:sqlite is built into Node ≥ 22.13 (prints a one-time ExperimentalWarning — harmless).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

CREATE TABLE IF NOT EXISTS products (
  sku TEXT PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL, category TEXT NOT NULL,
  sizes TEXT NOT NULL, returnable INTEGER NOT NULL, exchangeable INTEGER NOT NULL,
  is_innerwear INTEGER NOT NULL DEFAULT 0, is_sale INTEGER NOT NULL DEFAULT 0, notes TEXT, description TEXT
);
CREATE TABLE IF NOT EXISTS inventory (
  sku TEXT NOT NULL, size TEXT NOT NULL, qty INTEGER NOT NULL, PRIMARY KEY (sku, size)
);
CREATE TABLE IF NOT EXISTS pincodes (
  pincode TEXT PRIMARY KEY, city TEXT, state TEXT, zone TEXT NOT NULL,
  serviceable INTEGER NOT NULL, cod INTEGER NOT NULL, rto_rate REAL NOT NULL DEFAULT 0.15
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  customer_id TEXT, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT,
  address_line1 TEXT, address_line2 TEXT, landmark TEXT, city TEXT, state TEXT, pincode TEXT,
  payment_method TEXT NOT NULL,           -- cod | prepaid
  status TEXT NOT NULL,                   -- pending_confirmation | confirmed | on_hold | shipped | in_transit | out_for_delivery | delivery_failed | delivered | rto_initiated | rto_delivered | cancelled
  subtotal INTEGER NOT NULL, shipping_fee INTEGER NOT NULL DEFAULT 0, cod_fee INTEGER NOT NULL DEFAULT 0,
  discount INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL,
  cod_confirmation TEXT NOT NULL DEFAULT 'not_required', -- not_required | pending | confirmed | cancelled | on_hold | switched_prepaid
  confirmation_sent_at TEXT, reminder_sent_at TEXT, confirmed_at TEXT,
  risk_score INTEGER, risk_band TEXT, risk_reasons TEXT,
  awb TEXT, courier TEXT, eta_from TEXT, eta_to TEXT,
  ndr_attempts INTEGER NOT NULL DEFAULT 0, ndr_status TEXT, ndr_reason TEXT, ndr_contacted_at TEXT, ndr_resolution TEXT,
  rto_reason TEXT, cancel_reason TEXT,
  notes TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'seed',
  created_at TEXT NOT NULL, shipped_at TEXT, delivered_at TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(phone);
CREATE INDEX IF NOT EXISTS idx_orders_awb ON orders(awb);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, sku TEXT NOT NULL, name TEXT NOT NULL, size TEXT,
  qty INTEGER NOT NULL, price INTEGER NOT NULL, exchange_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS returns (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, item_id TEXT, phone TEXT NOT NULL,
  type TEXT NOT NULL, reason TEXT, new_size TEXT,
  status TEXT NOT NULL,                   -- requested | manual_review | approved | rejected | completed
  refund_amount INTEGER NOT NULL DEFAULT 0, refund_method TEXT,
  dedupe_key TEXT UNIQUE, created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_returns_phone ON returns(phone);

CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, return_id TEXT, amount INTEGER NOT NULL,
  method TEXT NOT NULL, status TEXT NOT NULL, reference TEXT,
  initiated_at TEXT NOT NULL, qc_passed_at TEXT, processed_at TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, channel TEXT NOT NULL DEFAULT 'web', customer_phone TEXT, customer_name TEXT,
  status TEXT NOT NULL DEFAULT 'ai',      -- ai | needs_human | human | resolved
  language TEXT NOT NULL DEFAULT 'en',
  verified_phone TEXT, verified_orders TEXT NOT NULL DEFAULT '[]', verify_attempts INTEGER NOT NULL DEFAULT 0,
  candidate_order_id TEXT, candidate_phone TEXT, pending_intent TEXT,
  pending_action TEXT, flow TEXT, context_order_id TEXT,
  handover_reason TEXT, handover_code TEXT, assigned_to TEXT, mood TEXT,
  injection_attempts INTEGER NOT NULL DEFAULT 0, tool_failures INTEGER NOT NULL DEFAULT 0,
  unresolved_count INTEGER NOT NULL DEFAULT 0, intents TEXT NOT NULL DEFAULT '[]',
  first_customer_at TEXT, first_response_ms INTEGER, handed_over_ever INTEGER NOT NULL DEFAULT 0,
  last_message TEXT, last_message_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_conv_phone ON conversations(customer_phone);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, -- customer | agent | human | system
  content TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}', dedupe_key TEXT UNIQUE, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL, name TEXT NOT NULL,
  input TEXT NOT NULL, output TEXT, ok INTEGER NOT NULL, error TEXT, duration_ms INTEGER, actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tc_conv ON tool_calls(conversation_id);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY, conversation_id TEXT, order_id TEXT, reason_code TEXT NOT NULL, reason TEXT NOT NULL,
  summary TEXT NOT NULL, mood TEXT, suggested_reply TEXT, priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, closed_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  field TEXT NOT NULL, old_value TEXT, new_value TEXT, actor TEXT NOT NULL, reason TEXT, conversation_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS webhook_events (
  source TEXT NOT NULL, event_id TEXT NOT NULL, topic TEXT, status TEXT NOT NULL, received_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (source, event_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_key TEXT UNIQUE, type TEXT NOT NULL, payload TEXT NOT NULL,
  run_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5, last_error TEXT, created_at TEXT NOT NULL, finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, run_at);

CREATE TABLE IF NOT EXISTS outbound_messages (
  dedupe_key TEXT PRIMARY KEY, conversation_id TEXT, channel TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL );

CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT, provider TEXT, model TEXT, purpose TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, latency_ms INTEGER, ok INTEGER, error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS courier_shipments (
  awb TEXT PRIMARY KEY, order_id TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  consignee TEXT NOT NULL, scheduled_date TEXT, timeline TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
`;

/**
 * Thin wrapper over Node's built-in `node:sqlite` (no native addon to compile) exposing the small
 * better-sqlite3-style surface the app uses: prepare().run/get/all, exec, pragma, transaction.
 */
export interface Stmt { run(...a: any[]): { changes: number | bigint; lastInsertRowid: number | bigint }; get(...a: any[]): any; all(...a: any[]): any[] }
export interface Db { prepare(sql: string): Stmt; exec(sql: string): void; pragma(p: string): void; transaction<T extends (...a: any[]) => any>(fn: T): T }

let db: Db | null = null;

function wrap(raw: DatabaseSync): Db {
  const cache = new Map<string, Stmt>();
  let depth = 0;
  return {
    prepare(sql) {
      let st = cache.get(sql);
      if (!st) {
        const s = raw.prepare(sql);
        // node:sqlite rejects `undefined`; better-sqlite3 code paths pass null for "no value"
        const fix = (a: any[]) => a.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
        st = {
          run: (...a) => s.run(...fix(a)) as any,
          get: (...a) => { const r = s.get(...fix(a)); return r ? { ...r } : undefined; },
          all: (...a) => s.all(...fix(a)).map((r: any) => ({ ...r })),
        };
        cache.set(sql, st);
      }
      return st;
    },
    exec: (sql) => raw.exec(sql),
    pragma: (p) => raw.exec(`PRAGMA ${p}`),
    transaction(fn) {
      return ((...args: any[]) => {
        if (depth > 0) return fn(...args); // nested: join the outer transaction
        depth++;
        raw.exec('BEGIN');
        try { const r = fn(...args); raw.exec('COMMIT'); return r; }
        catch (e) { raw.exec('ROLLBACK'); throw e; }
        finally { depth--; }
      }) as any;
    },
  };
}

export function getDb(): Db {
  if (db) return db;
  if (config.dbPath !== ':memory:') fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  db = wrap(new DatabaseSync(config.dbPath));
  if (config.dbPath !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

export function resetDb() {
  const d = getDb();
  const tables = d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[];
  d.exec('PRAGMA foreign_keys=OFF');
  for (const t of tables) d.exec(`DELETE FROM ${t.name}`);
}

export const nowIso = () => new Date().toISOString();
export const json = <T = any>(v: string | null | undefined, d: T): T => {
  if (!v) return d;
  try { return JSON.parse(v) as T; } catch { return d; }
};
