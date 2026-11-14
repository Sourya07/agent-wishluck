import crypto from 'node:crypto';

export const signBase64 = (secret: string, body: string | Buffer) =>
  crypto.createHmac('sha256', secret).update(body).digest('base64');

export const signHex = (secret: string, body: string | Buffer) =>
  crypto.createHmac('sha256', secret).update(body).digest('hex');

export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a || '');
  const bb = Buffer.from(b || '');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Accepts base64 (Shopify style) or "sha256=<hex>" (GitHub/WhatsApp style). */
export function verifySignature(secret: string, body: Buffer | string, header?: string | null) {
  if (!secret || !header) return false;
  const h = header.trim();
  if (h.startsWith('sha256=')) return safeEqual(h.slice(7), signHex(secret, body));
  return safeEqual(h, signBase64(secret, body));
}
