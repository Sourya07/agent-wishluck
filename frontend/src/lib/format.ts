export const inr = (n?: number | null) => (n == null ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`);

export function ago(iso?: string | null) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
export const dateTime = (iso?: string | null) => iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—';
export const date = (iso?: string | null) => iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
export const time = (iso?: string | null) => iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : '';
export const ms = (v?: number | null) => v == null ? '—' : v < 1000 ? `${Math.round(v)} ms` : v < 60000 ? `${(v / 1000).toFixed(1)} s` : `${(v / 60000).toFixed(1)} min`;
export const pct = (v?: number | null) => v == null ? '—' : `${Math.round(v * 100)}%`;
export const label = (s?: string | null) => (s ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
export const initials = (name?: string | null) => (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?';
