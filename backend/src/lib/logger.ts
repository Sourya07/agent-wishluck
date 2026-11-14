import { maskDeep, maskText } from './pii.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = order[(process.env.LOG_LEVEL as Level) || 'info'] ?? 20;

function write(level: Level, msg: string, ctx?: Record<string, unknown>) {
  if (order[level] < min) return;
  const line = { t: new Date().toISOString(), level, msg: maskText(msg), ...(ctx ? maskDeep(ctx) : {}) };
  const s = JSON.stringify(line);
  if (level === 'error' || level === 'warn') console.error(s);
  else console.log(s);
}

/** Structured JSON logger. Every line is passed through the PII masker. */
export const log = {
  debug: (m: string, c?: Record<string, unknown>) => write('debug', m, c),
  info: (m: string, c?: Record<string, unknown>) => write('info', m, c),
  warn: (m: string, c?: Record<string, unknown>) => write('warn', m, c),
  error: (m: string, c?: Record<string, unknown>) => write('error', m, c),
};
