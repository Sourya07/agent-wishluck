/** PII masking used for logs, tool-call traces and anything that leaves the system boundary. */
const PHONE_RE = /(?<!\d)(?:\+?91[-\s]?)?([6-9]\d{9})(?!\d)/g;
const EMAIL_RE = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9])[A-Za-z0-9.-]*\.([A-Za-z]{2,})/g;

export function maskPhone(p?: string | null): string {
  if (!p) return '';
  const d = String(p).replace(/\D/g, '').slice(-10);
  if (d.length < 6) return '******';
  return `${d.slice(0, 2)}******${d.slice(-2)}`;
}

export function maskEmail(e?: string | null): string {
  if (!e) return '';
  return String(e).replace(EMAIL_RE, (_m, a, b, tld) => `${a}***@${b}***.${tld}`);
}

export function maskAddress(a?: string | null): string {
  if (!a) return '';
  const s = String(a);
  if (s.length <= 4) return '****';
  return `${s.slice(0, 3)}${'*'.repeat(Math.min(12, s.length - 3))}`;
}

export function maskText(s: string): string {
  return s.replace(PHONE_RE, (m, d) => m.replace(d, maskPhone(d))).replace(EMAIL_RE, (_m, a, b, tld) => `${a}***@${b}***.${tld}`);
}

const ADDRESS_KEYS = new Set(['address', 'address_line1', 'address_line2', 'address1', 'address2', 'landmark', 'street']);
const PHONE_KEYS = new Set(['phone', 'alternate_phone', 'customer_phone', 'verified_phone', 'candidate_phone', 'mobile']);
const EMAIL_KEYS = new Set(['email']);

/** Deep-mask an object for logging. Never mutates the input. */
export function maskDeep(v: any, depth = 0): any {
  if (depth > 6 || v == null) return v;
  if (typeof v === 'string') return maskText(v);
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, depth + 1));
  if (typeof v === 'object') {
    const out: any = {};
    for (const [k, val] of Object.entries(v)) {
      const key = k.toLowerCase();
      if (PHONE_KEYS.has(key) && typeof val === 'string') out[k] = maskPhone(val);
      else if (EMAIL_KEYS.has(key) && typeof val === 'string') out[k] = maskEmail(val);
      else if (ADDRESS_KEYS.has(key) && typeof val === 'string') out[k] = maskAddress(val);
      else out[k] = maskDeep(val, depth + 1);
    }
    return out;
  }
  return v;
}

export const normalizePhone = (p?: string | null) => (p ? String(p).replace(/\D/g, '').slice(-10) : '');
