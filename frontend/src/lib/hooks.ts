import { useCallback, useEffect, useRef, useState } from 'react';
import { api, streamUrl } from './api';

/** Fetch with loading / error / reload. */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(!!path);
  const ctrl = useRef<AbortController | null>(null);
  const load = useCallback(async (quiet = false) => {
    if (!path) return;
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    if (!quiet) setLoading(true);
    try {
      const d = await api<T>(path, { signal: c.signal });
      if (!c.signal.aborted) { setData(d); setError(null); }
    } catch (e: any) {
      if (e.name !== 'AbortError') setError(e);
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
  }, [path]);
  useEffect(() => { void load(); return () => ctrl.current?.abort(); }, [load, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, loading, reload: load, setData };
}

/** Server-sent events with auto-reconnect. Returns connection state. */
export function useEventStream(path: string | null, onEvent: (e: any) => void) {
  const [connected, setConnected] = useState(false);
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    if (!path) return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout>;
    let closed = false;
    const open = () => {
      es = new EventSource(streamUrl(path));
      es.onopen = () => setConnected(true);
      es.onmessage = (m) => { try { cb.current(JSON.parse(m.data)); } catch { /* ignore */ } };
      es.onerror = () => { setConnected(false); es?.close(); if (!closed) retry = setTimeout(open, 2000); };
    };
    open();
    return () => { closed = true; clearTimeout(retry); es?.close(); };
  }, [path]);
  return connected;
}

/** Debounce a callback (used to coalesce bursts of SSE events into one refetch). */
export function useDebounced(fn: () => void, ms = 250) {
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const f = useRef(fn);
  f.current = fn;
  return useCallback(() => { clearTimeout(t.current); t.current = setTimeout(() => f.current(), ms); }, [ms]);
}
