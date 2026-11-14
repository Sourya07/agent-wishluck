import { log } from './logger.js';

export class HttpError extends Error {
  constructor(message: string, public status?: number, public body?: unknown) { super(message); }
}

export interface FetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  /** retry only on network errors / 5xx / 429 */
  label?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch() with a hard timeout, JSON handling and exponential-backoff retries on transient failures. */
export async function fetchJson<T = any>(url: string, opts: FetchOpts = {}): Promise<T> {
  const { method = 'GET', headers = {}, body, timeoutMs = 5000, retries = 2, label = url } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let data: any = text;
      try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
      if (!res.ok) {
        const err = new HttpError(`${label} -> HTTP ${res.status}`, res.status, data);
        if (res.status >= 500 || res.status === 429) throw err;
        // 4xx: do not retry
        (err as any).noRetry = true;
        throw err;
      }
      return data as T;
    } catch (e: any) {
      lastErr = e?.name === 'AbortError' ? new HttpError(`${label} timed out after ${timeoutMs}ms`) : e;
      if (e?.noRetry || attempt === retries) break;
      const wait = 250 * 2 ** attempt + Math.random() * 100;
      log.warn('http retry', { label, attempt: attempt + 1, error: String((lastErr as Error).message) });
      await sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}
