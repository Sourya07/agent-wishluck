/**
 * Rules-based RTO risk score for COD orders (0–100).
 * Each signal adds (or removes) points and produces a plain-English reason that is shown on the order page.
 * Weights and thresholds live in Settings so ops can tune them without a deploy.
 */
import type { PincodeInfo } from '../policy/catalog.js';
import type { Settings } from '../settings.js';

export interface RiskInput {
  total: number;
  address: { line1?: string | null; line2?: string | null; landmark?: string | null; city?: string | null };
  pincode: PincodeInfo | null;
  phone: string;
  name?: string;
  email?: string | null;
  createdAt: string;
  history: {
    /** previously delivered orders for this phone */
    deliveredOrders: number;
    /** previous orders on this phone that were refused / returned to origin */
    rtoCount: number;
    /** other COD orders on this phone in the last 24h */
    codOrdersLast24h: number;
  };
}

export interface RiskReason { signal: string; points: number; detail: string }
export interface RiskResult { score: number; band: 'low' | 'medium' | 'high'; reasons: RiskReason[]; addressQuality: AddressQuality }

export interface AddressQuality { hasHouseNumber: boolean; vague: boolean; tooShort: boolean; vagueTerms: string[] }

const VAGUE_TERMS = [
  'near', 'nr.', 'opp', 'opposite', 'behind', 'beside', 'next to', 'ke paas', 'ke pass', 'paas', 'samne', 'saamne', 'peeche',
  'mandir', 'temple', 'masjid', 'mosque', 'church', 'gurudwara', 'chowk', 'chauraha', 'tiraha', 'bus stand', 'bus stop',
  'school', 'market', 'gali', 'wali gali', 'village', 'gaon', 'post office', 'petrol pump', 'water tank',
];
const HOUSE_RE = /\b(h\.?\s?no\.?|house|flat|plot|door|room|apt|apartment|block|tower|floor|shop|qtr|quarter|sector)\b|#\s*\d|\b\d{1,4}[a-z]?(?:\s*[\/-]\s*\d{1,4}[a-z]?)?\b/i;

export function assessAddress(a: RiskInput['address']): AddressQuality {
  const main = [a.line1, a.line2].filter(Boolean).join(', ').trim();
  const all = [main, a.landmark].filter(Boolean).join(', ').toLowerCase();
  const withoutPin = main.replace(/\b\d{6}\b/g, '').replace(/\b(gali|lane|street|road|sector)\s*(no\.?|number)?\s*\d{1,3}\b/gi, ''); // lane/sector numbers are not a house number
  const hasHouseNumber = HOUSE_RE.test(withoutPin);
  const vagueTerms = VAGUE_TERMS.filter((t) => new RegExp(`(^|[^a-z])${t.replace('.', '\\.')}([^a-z]|$)`, 'i').test(all));
  const tooShort = main.replace(/[^a-z0-9]/gi, '').length < 15;
  // An address is "vague" when it leans on landmarks instead of a house/street — e.g. "near Shiv mandir".
  const vague = vagueTerms.length > 0 && (!hasHouseNumber || tooShort);
  return { hasHouseNumber, vague, tooShort, vagueTerms };
}

function suspiciousContact(phone: string, name?: string, email?: string | null) {
  const d = phone.replace(/\D/g, '').slice(-10);
  const reasons: string[] = [];
  if (/^(\d)\1{6,}/.test(d) || /(\d)\1{6,}$/.test(d)) reasons.push('phone number has a long run of the same digit');
  if ('01234567890123456789'.includes(d) || '98765432109876543210'.includes(d)) reasons.push('phone number is a sequential pattern');
  if (name && (name.trim().length < 3 || /\d/.test(name) || /^(test|abc|xyz|asdf)/i.test(name.trim()))) reasons.push('customer name looks like a placeholder');
  if (email && /@(mailinator|tempmail|10minutemail|guerrillamail|yopmail)\./i.test(email)) reasons.push('disposable email domain');
  return reasons;
}

export function scoreCodRisk(input: RiskInput, cfg: Settings['risk']): RiskResult {
  const w = cfg.weights;
  const reasons: RiskReason[] = [];
  const add = (signal: string, points: number, detail: string) => { if (points !== 0) reasons.push({ signal, points, detail }); };

  // 1. Order value — expensive COD orders hurt most when refused.
  if (input.total > 4000) add('order_value', w.veryHighValue, `High order value (₹${input.total.toLocaleString('en-IN')}) — costly if refused.`);
  else if (input.total > 2500) add('order_value', w.highValue, `Above-average order value (₹${input.total.toLocaleString('en-IN')}).`);

  // 2. Address quality
  const aq = assessAddress(input.address);
  if (aq.vague) add('address_vague', w.weakAddress, `Address relies on a landmark ("${aq.vagueTerms.slice(0, 2).join('", "')}") instead of a full street address.`);
  if (!aq.hasHouseNumber) add('address_no_house_no', w.noHouseNumber, 'No house / flat number in the address.');

  // 3. Pincode RTO history
  const pin = input.pincode;
  if (pin) {
    if (pin.rtoRate >= 0.3) add('pincode_rto', w.pincodeRto, `Pincode ${pin.pincode} has a high refusal rate (${Math.round(pin.rtoRate * 100)}% of COD orders come back).`);
    else if (pin.rtoRate >= 0.2) add('pincode_rto', Math.round(w.pincodeRto / 2), `Pincode ${pin.pincode} has an above-average refusal rate (${Math.round(pin.rtoRate * 100)}%).`);
    if (pin.zone === 'ne_jk') add('remote_zone', w.remoteZone, 'Remote zone (North East / J&K) — longer transit, more refusals.');
  } else {
    add('pincode_unknown', Math.round(w.pincodeRto / 2), 'Pincode could not be validated.');
  }

  // 4. Customer history
  const h = input.history;
  if (h.rtoCount > 0) add('past_refusals', Math.min(2, h.rtoCount) * w.pastRefusal, `${h.rtoCount} earlier order(s) on this phone number were refused / returned to origin.`);
  if (h.deliveredOrders === 0 && h.rtoCount === 0) add('new_customer', w.newCustomer, 'First order from this phone number.');
  else if (h.deliveredOrders >= 2 && h.rtoCount === 0) add('repeat_customer', w.repeatCustomerCredit, `Repeat customer with ${h.deliveredOrders} delivered orders and no refusals.`);
  if (h.codOrdersLast24h >= 1) add('cod_velocity', w.codVelocity, `${h.codOrdersLast24h} other COD order(s) from this number in the last 24 hours.`);

  // 5. Contact quality
  const sus = suspiciousContact(input.phone, input.name, input.email);
  if (sus.length) add('suspicious_contact', w.suspiciousContact, `Contact details look unreliable: ${sus.join('; ')}.`);

  // 6. Late-night impulse orders (IST)
  const istHour = new Date(new Date(input.createdAt).getTime() + 5.5 * 3600_000).getUTCHours();
  if (istHour >= 0 && istHour < 5) add('late_night', w.lateNight, 'Placed between midnight and 5 am (impulse orders are refused more often).');

  const raw = reasons.reduce((s, r) => s + r.points, 0);
  const score = Math.max(0, Math.min(100, raw));
  const band = score >= cfg.highThreshold ? 'high' : score >= cfg.mediumThreshold ? 'medium' : 'low';
  if (reasons.length === 0) reasons.push({ signal: 'none', points: 0, detail: 'No risk signals found.' });
  return { score, band, reasons, addressQuality: aq };
}
