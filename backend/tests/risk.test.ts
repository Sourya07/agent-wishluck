import { describe, expect, it } from 'vitest';
import { assessAddress, scoreCodRisk } from '../src/risk/riskScore.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';

const cfg = DEFAULT_SETTINGS.risk;
const pin = (o: any = {}) => ({ pincode: '273001', city: 'Gorakhpur', state: 'UP', zone: 'roi' as const, serviceable: true, cod: true, rtoRate: 0.34, known: true, ...o });
const base = { total: 999, address: { line1: 'House 17, Sector 12, Indira Nagar' }, pincode: pin({ rtoRate: 0.1 }), phone: '9811223344', name: 'Rahul Verma', createdAt: '2026-11-15T06:00:00Z', history: { deliveredOrders: 0, rtoCount: 0, codOrdersLast24h: 0 } };

describe('COD risk score', () => {
  it('Appendix B #7: ₹4,600, "near Shiv mandir", first-time customer → high, with reasons', () => {
    const r = scoreCodRisk({ ...base, total: 4600, address: { line1: 'near Shiv mandir' }, pincode: pin(), phone: '9123400001', name: 'Bhola Prasad' }, cfg);
    expect(r.band).toBe('high');
    const s = r.reasons.map((x) => x.signal);
    expect(s).toEqual(expect.arrayContaining(['order_value', 'address_vague', 'address_no_house_no', 'pincode_rto', 'new_customer']));
    expect(r.reasons.find((x) => x.signal === 'address_vague')!.detail).toMatch(/near|mandir/);
  });
  it('repeat customer with a full address in a metro is low risk', () => {
    const r = scoreCodRisk({ ...base, address: { line1: 'Flat 1204, Tower B, Hiranandani Gardens, Powai' }, pincode: pin({ pincode: '400076', rtoRate: 0.09, zone: 'metro' }), history: { deliveredOrders: 2, rtoCount: 0, codOrdersLast24h: 0 } }, cfg);
    expect(r.band).toBe('low');
    expect(r.score).toBe(0);
  });
  it('past refusals and COD velocity add risk', () => {
    const r = scoreCodRisk({ ...base, history: { deliveredOrders: 0, rtoCount: 2, codOrdersLast24h: 1 } }, cfg);
    expect(r.reasons.find((x) => x.signal === 'past_refusals')!.points).toBe(50);
    expect(r.reasons.some((x) => x.signal === 'cod_velocity')).toBe(true);
    expect(r.band).toBe('high');
  });
  it('is clamped to 0–100 and respects thresholds from settings', () => {
    const worst = scoreCodRisk({ ...base, total: 4900, address: { line1: 'near temple' }, pincode: pin({ zone: 'ne_jk' }), phone: '9999999999', name: 'test', createdAt: '2026-11-14T20:00:00Z', history: { deliveredOrders: 0, rtoCount: 3, codOrdersLast24h: 3 } }, cfg);
    expect(worst.score).toBe(100);
    const lenient = scoreCodRisk({ ...base, total: 4600, address: { line1: 'near Shiv mandir' }, pincode: pin() }, { ...cfg, highThreshold: 95, mediumThreshold: 90 });
    expect(lenient.band).toBe('low');
  });
  it('address quality heuristics', () => {
    expect(assessAddress({ line1: 'near Shiv mandir' })).toMatchObject({ vague: true, hasHouseNumber: false });
    expect(assessAddress({ line1: 'H.No 221, Okhla Vihar, near masjid' })).toMatchObject({ vague: false, hasHouseNumber: true });
    expect(assessAddress({ line1: 'Gali no 3, near water tank' }).vague).toBe(true);
  });
});
