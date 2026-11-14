/**
 * Hallucination guard. Every order-specific fact in a model reply (order ids, AWBs, amounts, dates, links,
 * phone numbers, return/refund ids) must appear in a tool result, the policy text, or what the customer said.
 * If not, the engine asks the model to rewrite once, then strips the offending sentences.
 */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export interface Claim { kind: 'order_id' | 'awb' | 'amount' | 'date' | 'url' | 'phone' | 'ref_id'; raw: string; norm: string }

export function extractClaims(text: string): Claim[] {
  const claims: Claim[] = [];
  const push = (kind: Claim['kind'], raw: string, norm: string) => claims.push({ kind, raw, norm });
  for (const m of text.matchAll(/https?:\/\/[^\s)>\]"']+/g)) push('url', m[0], m[0].replace(/[.,;:!?]+$/, ''));
  const noUrls = text.replace(/https?:\/\/[^\s)>\]"']+/g, ' ');
  for (const m of noUrls.matchAll(/\bWL\d{5}\b/gi)) push('order_id', m[0], m[0].toUpperCase());
  for (const m of noUrls.matchAll(/\b(?:RET|EXC|RFD|TKT)-[A-Z0-9]{4,}\b/g)) push('ref_id', m[0], m[0]);
  for (const m of noUrls.matchAll(/\b[A-Z]{2,4}\d{8,12}\b/g)) if (!/^WL\d{5}$/i.test(m[0])) push('awb', m[0], m[0]);
  for (const m of noUrls.matchAll(/(?:₹|rs\.?\s?|inr\s?)\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:rupees|rupaye|rs\b)/gi)) {
    const n = (m[1] ?? m[2]).replace(/,/g, '').replace(/\.0+$/, '');
    push('amount', m[0], n);
  }
  for (const m of noUrls.matchAll(/(?<!\d)([6-9]\d{9})(?!\d)/g)) push('phone', m[0], m[1]);
  for (const m of noUrls.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) push('date', m[0], `${Number(m[3])}-${Number(m[2])}`);
  for (const m of noUrls.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?/gi)) push('date', m[0], `${Number(m[1])}-${MONTHS.indexOf(m[2].toLowerCase()) + 1}`);
  for (const m of noUrls.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?!\d)/gi)) push('date', m[0], `${Number(m[2])}-${MONTHS.indexOf(m[1].toLowerCase()) + 1}`);
  return claims;
}

export interface Corpus { text: string; numbers: Set<string>; dates: Set<string> }

export function buildCorpus(parts: string[]): Corpus {
  const text = parts.join('\n');
  const numbers = new Set<string>();
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = m[0].replace(/,/g, '');
    numbers.add(n); numbers.add(n.replace(/\.0+$/, ''));
    if (n.includes('.')) numbers.add(String(Math.round(Number(n))));
  }
  const dates = new Set<string>();
  for (const m of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})[^"\s]*)?/g)) {
    if (m[4]) {
      const d = new Date(m[0].replace(/[",\s]+$/, ''));
      if (!Number.isNaN(d.getTime())) {
        dates.add(`${d.getUTCDate()}-${d.getUTCMonth() + 1}`);
        const ist = new Date(d.getTime() + 5.5 * 3600_000);
        dates.add(`${ist.getUTCDate()}-${ist.getUTCMonth() + 1}`);
      }
    }
    dates.add(`${Number(m[3])}-${Number(m[2])}`);
  }
  for (const m of text.matchAll(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/gi)) dates.add(`${Number(m[1])}-${MONTHS.indexOf(m[2].toLowerCase()) + 1}`);
  return { text, numbers, dates };
}

export function ungrounded(reply: string, corpus: Corpus): Claim[] {
  const lower = corpus.text.toLowerCase();
  return extractClaims(reply).filter((c) => {
    switch (c.kind) {
      case 'url': return !corpus.text.includes(c.norm);
      case 'order_id': case 'awb': case 'ref_id': return !lower.includes(c.norm.toLowerCase());
      case 'amount': return !corpus.numbers.has(c.norm);
      case 'phone': return !corpus.text.includes(c.norm);
      case 'date': return !corpus.dates.has(c.norm);
    }
  });
}

/** Removes sentences that contain an ungrounded claim. */
export function stripClaims(reply: string, bad: Claim[]): string {
  const sentences = reply.split(/(?<=[.!?।])\s+|\n+/);
  const kept = sentences.filter((s) => !bad.some((b) => s.includes(b.raw)));
  return kept.join(' ').trim();
}
