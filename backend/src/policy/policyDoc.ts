import { SIZE_CHART, productBySku } from './catalog.js';

/** The written store policy (Appendix A). Served verbatim by the get_policy tool. */
export const POLICY_DOC: Record<string, string> = {
  returns: 'Returns: within 7 days of delivery, unused and with tags. Innerwear (Cotton briefs, pack of 3) cannot be returned. Sale items can only be exchanged for another size — no refund. Returns above ₹1,500, damage claims without a photo, and customers with 3 or more returns in the last 60 days go to manual review.',
  exchange: 'Exchange: size exchange within 7 days of delivery if the new size is in stock. One exchange per item. The Canvas tote bag can be returned but not exchanged (one size).',
  cancellation: 'Cancellation: free before the order ships. After it ships, the customer can refuse the delivery (prepaid orders are refunded minus ₹99 shipping) or return it after delivery.',
  refunds: 'Refunds: prepaid orders are refunded to the original payment method in 5 to 7 working days after the returned item passes quality check. COD orders are refunded by bank transfer or store credit, whichever the customer picks.',
  cod: 'COD: available for orders between ₹299 and ₹4,999, with a ₹49 COD fee. Not available on non-COD pincodes. Customers get 5% off if they switch to prepaid.',
  shipping: 'Shipping: free above ₹999, otherwise ₹79. Metro cities 2 to 4 days, rest of India 4 to 7 days, North East and J&K 6 to 9 days.',
  manual_review: 'Manual review: any refund or goodwill request above ₹1,500, damage claims without a photo, and customers with 3 or more returns in the last 60 days.',
};

export const POLICY_TEXT = Object.values(POLICY_DOC).join('\n');

export interface SizeAdvice { sku: string; recommended: string | null; alternatives: string[]; basis: string; chart: unknown }

/** Deterministic size recommendation from the size chart. */
export function recommendSize(sku: string, heightCm?: number, weightKg?: number): SizeAdvice {
  const p = productBySku(sku);
  if (!p) return { sku, recommended: null, alternatives: [], basis: 'Unknown product', chart: null };
  if (p.category === 'bag') return { sku, recommended: 'ONE', alternatives: [], basis: 'One size', chart: null };
  if (p.category === 'jeans') {
    const fits = SIZE_CHART.jeans.filter((r) => weightKg != null && weightKg >= r.weightKg[0] && weightKg <= r.weightKg[1]).map((r) => r.size);
    return { sku, recommended: fits[0] ?? null, alternatives: fits.slice(1), basis: weightKg ? `weight ${weightKg} kg vs waist chart — best is to match your usual waist size in inches` : 'Need weight or waist size', chart: SIZE_CHART.jeans };
  }
  const rows = SIZE_CHART.tops.filter((r) => p.sizes.includes(r.size));
  const score = (r: (typeof rows)[number]) => {
    let s = 0;
    if (heightCm != null) s += heightCm >= r.heightCm[0] && heightCm <= r.heightCm[1] ? 2 : 0;
    if (weightKg != null) s += weightKg >= r.weightKg[0] && weightKg <= r.weightKg[1] ? 3 : 0;
    return s;
  };
  const ranked = rows.map((r) => ({ r, s: score(r) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  let rec = ranked[0]?.r.size ?? null;
  let note = '';
  if (rec && p.sku === 'WL-TEE-02') note = ' The graphic tee is an oversized fit; size down for a regular fit.';
  return {
    sku, recommended: rec, alternatives: ranked.slice(1).map((x) => x.r.size),
    basis: `height ${heightCm ?? '?'} cm, weight ${weightKg ?? '?'} kg matched against the size chart.${note}`,
    chart: rows.map(({ size, chest }) => ({ size, chest_in: chest })),
  };
}

/** Parse "5'8", "5 ft 8", "173 cm" → cm */
export function parseHeightCm(text: string): number | undefined {
  const ft = text.match(/(\d)\s*(?:'|ft|feet|foot)\s*(\d{1,2})?\s*(?:"|in|inch)?/i);
  if (ft) return Math.round(Number(ft[1]) * 30.48 + Number(ft[2] || 0) * 2.54);
  const cm = text.match(/(\d{3})\s*cm/i);
  if (cm) return Number(cm[1]);
  return undefined;
}
export function parseWeightKg(text: string): number | undefined {
  const m = text.match(/(\d{2,3})\s*(?:kg|kgs|kilo)/i);
  return m ? Number(m[1]) : undefined;
}
