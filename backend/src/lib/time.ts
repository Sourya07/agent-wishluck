export const DAY = 86_400_000;
export const daysAgo = (n: number, from = Date.now()) => new Date(from - n * DAY).toISOString();
export const daysFromNow = (n: number, from = Date.now()) => new Date(from + n * DAY).toISOString();
export const dateOnly = (iso: string) => iso.slice(0, 10);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** IST friendly date, e.g. "Tue, 18 Nov" */
export function fmtDate(iso?: string | null) {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + 5.5 * 3600_000);
  return `${DOW[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** YYYY-MM-DD in IST */
export function istDate(ms = Date.now()) {
  return new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10);
}

export const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
