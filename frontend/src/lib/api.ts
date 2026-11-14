const TOKEN = import.meta.env.VITE_DASHBOARD_TOKEN as string | undefined;

export class ApiError extends Error {
  constructor(message: string, public status: number, public body?: unknown) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(TOKEN ? { 'x-dashboard-token': TOKEN } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = typeof data?.error === 'string' ? data.error : Array.isArray(data?.error) ? data.error.map((e: any) => e.message).join(', ') : `Request failed (${res.status})`;
    throw new ApiError(msg, res.status, data);
  }
  return data as T;
}

export const streamUrl = (path: string) => `/api${path}${TOKEN ? `${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}` : ''}`;
