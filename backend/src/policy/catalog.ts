/** Appendix A catalogue + reference data. Single source of truth for seed, policy and tools. */

export interface Product {
  sku: string; name: string; price: number; category: 'kurta' | 'tee' | 'jeans' | 'innerwear' | 'bag';
  sizes: string[]; returnable: boolean; exchangeable: boolean; isInnerwear: boolean; isSale: boolean;
  notes: string; description: string;
}

export const PRODUCTS: Product[] = [
  { sku: 'WL-KUR-01', name: 'Cotton printed kurta', price: 1299, category: 'kurta', sizes: ['S', 'M', 'L', 'XL', 'XXL'], returnable: true, exchangeable: true, isInnerwear: false, isSale: false, notes: 'Can be returned or exchanged', description: '100% cotton, regular fit, hip length, block print. Machine wash cold.' },
  { sku: 'WL-TEE-02', name: 'Oversized graphic tee', price: 699, category: 'tee', sizes: ['S', 'M', 'L', 'XL'], returnable: true, exchangeable: true, isInnerwear: false, isSale: false, notes: 'Can be returned or exchanged', description: '240 GSM cotton, drop shoulder, oversized fit — size down for a regular fit.' },
  { sku: 'WL-JNS-03', name: 'Relaxed fit jeans', price: 1799, category: 'jeans', sizes: ['28', '30', '32', '34', '36'], returnable: true, exchangeable: true, isInnerwear: false, isSale: false, notes: 'Can be returned or exchanged', description: 'Relaxed fit, mid rise, 98% cotton 2% elastane. Size = waist in inches.' },
  { sku: 'WL-BRF-04', name: 'Cotton briefs, pack of 3', price: 499, category: 'innerwear', sizes: ['S', 'M', 'L', 'XL'], returnable: false, exchangeable: false, isInnerwear: true, isSale: false, notes: 'Innerwear, no returns', description: 'Combed cotton, pack of 3, assorted colours.' },
  { sku: 'WL-BAG-05', name: 'Canvas tote bag', price: 899, category: 'bag', sizes: ['ONE'], returnable: true, exchangeable: false, isInnerwear: false, isSale: false, notes: 'Can be returned', description: '12 oz canvas, inner zip pocket, 40 x 38 cm.' },
  { sku: 'WL-SAL-06', name: 'Sale tee', price: 399, category: 'tee', sizes: ['S', 'M', 'L', 'XL'], returnable: false, exchangeable: true, isInnerwear: false, isSale: true, notes: 'Sale item, size exchange only', description: 'Regular fit cotton tee from the end-of-season sale.' },
];

export const productBySku = (sku: string) => PRODUCTS.find((p) => p.sku === sku.toUpperCase());

/** Initial stock per SKU/size. */
export const STOCK: Record<string, Record<string, number>> = {
  'WL-KUR-01': { S: 6, M: 9, L: 4, XL: 0, XXL: 2 },
  'WL-TEE-02': { S: 10, M: 12, L: 7, XL: 3 },
  'WL-JNS-03': { '28': 3, '30': 5, '32': 6, '34': 0, '36': 2 },
  'WL-BRF-04': { S: 20, M: 25, L: 18, XL: 10 },
  'WL-BAG-05': { ONE: 15 },
  'WL-SAL-06': { S: 0, M: 5, L: 3, XL: 1 },
};

/**
 * Size charts (body measurements). Recommendation is computed in code from these
 * tables — the model never guesses sizes.
 */
export const SIZE_CHART = {
  tops: [
    // kurta and tees: chest in inches + typical height/weight ranges
    { size: 'S', chest: '36-38', heightCm: [155, 168], weightKg: [45, 60] },
    { size: 'M', chest: '38-40', heightCm: [163, 175], weightKg: [58, 70] },
    { size: 'L', chest: '40-42', heightCm: [170, 181], weightKg: [68, 80] },
    { size: 'XL', chest: '42-44', heightCm: [175, 188], weightKg: [78, 92] },
    { size: 'XXL', chest: '44-46', heightCm: [178, 195], weightKg: [90, 110] },
  ],
  jeans: [
    { size: '28', waist: '28-29', weightKg: [45, 58] },
    { size: '30', waist: '30-31', weightKg: [56, 66] },
    { size: '32', waist: '32-33', weightKg: [64, 75] },
    { size: '34', waist: '34-35', weightKg: [73, 85] },
    { size: '36', waist: '36-37', weightKg: [83, 98] },
  ],
};

export type Zone = 'metro' | 'roi' | 'ne_jk';
export interface PincodeInfo {
  pincode: string; city: string | null; state: string | null; zone: Zone; serviceable: boolean; cod: boolean; rtoRate: number; known: boolean;
}

export const PINCODES: Omit<PincodeInfo, 'known'>[] = [
  { pincode: '110001', city: 'New Delhi', state: 'Delhi', zone: 'metro', serviceable: true, cod: true, rtoRate: 0.12 },
  { pincode: '110092', city: 'Delhi', state: 'Delhi', zone: 'metro', serviceable: true, cod: true, rtoRate: 0.14 },
  { pincode: '400001', city: 'Mumbai', state: 'Maharashtra', zone: 'metro', serviceable: true, cod: true, rtoRate: 0.1 },
  { pincode: '400076', city: 'Mumbai', state: 'Maharashtra', zone: 'metro', serviceable: true, cod: true, rtoRate: 0.09 },
  { pincode: '560001', city: 'Bengaluru', state: 'Karnataka', zone: 'metro', serviceable: true, cod: true, rtoRate: 0.08 },
  { pincode: '560034', city: 'Bengaluru', state: 'Karnataka', zone: 'metro', serviceable: true, cod: true, rtoRate: 0.07 },
  { pincode: '600001', city: 'Chennai', state: 'Tamil Nadu', zone: 'metro', serviceable: true, cod: true, rtoRate: 0.1 },
  { pincode: '700001', city: 'Kolkata', state: 'West Bengal', zone: 'metro', serviceable: true, cod: true, rtoRate: 0.15 },
  { pincode: '500001', city: 'Hyderabad', state: 'Telangana', zone: 'metro', serviceable: true, cod: true, rtoRate: 0.11 },
  { pincode: '411001', city: 'Pune', state: 'Maharashtra', zone: 'metro', serviceable: true, cod: true, rtoRate: 0.09 },
  { pincode: '226010', city: 'Lucknow', state: 'Uttar Pradesh', zone: 'roi', serviceable: true, cod: true, rtoRate: 0.18 },
  { pincode: '302001', city: 'Jaipur', state: 'Rajasthan', zone: 'roi', serviceable: true, cod: true, rtoRate: 0.17 },
  { pincode: '273001', city: 'Gorakhpur', state: 'Uttar Pradesh', zone: 'roi', serviceable: true, cod: true, rtoRate: 0.34 },
  { pincode: '800001', city: 'Patna', state: 'Bihar', zone: 'roi', serviceable: true, cod: true, rtoRate: 0.31 },
  { pincode: '452001', city: 'Indore', state: 'Madhya Pradesh', zone: 'roi', serviceable: true, cod: true, rtoRate: 0.13 },
  { pincode: '781001', city: 'Guwahati', state: 'Assam', zone: 'ne_jk', serviceable: true, cod: true, rtoRate: 0.22 },
  { pincode: '795001', city: 'Imphal', state: 'Manipur', zone: 'ne_jk', serviceable: true, cod: false, rtoRate: 0.28 },
  { pincode: '190001', city: 'Srinagar', state: 'Jammu & Kashmir', zone: 'ne_jk', serviceable: true, cod: false, rtoRate: 0.25 },
  { pincode: '744101', city: 'Port Blair', state: 'Andaman & Nicobar', zone: 'ne_jk', serviceable: false, cod: false, rtoRate: 0.3 },
];

/** Fallback for pincodes not in the table: derive zone from the postal circle prefix. */
export function inferPincode(pin: string): PincodeInfo | null {
  if (!/^[1-9]\d{5}$/.test(pin)) return null;
  const p2 = Number(pin.slice(0, 2));
  const p3 = Number(pin.slice(0, 3));
  // 78-79: North East, 18-19: J&K/Ladakh, 744: Andaman (not serviceable)
  if (p3 === 744) return { pincode: pin, city: null, state: null, zone: 'ne_jk', serviceable: false, cod: false, rtoRate: 0.3, known: false };
  if (p2 === 78) return { pincode: pin, city: null, state: 'Assam', zone: 'ne_jk', serviceable: true, cod: true, rtoRate: 0.22, known: false };
  if (p2 === 79) return { pincode: pin, city: null, state: 'North East', zone: 'ne_jk', serviceable: true, cod: false, rtoRate: 0.27, known: false };
  if (p2 === 18 || p2 === 19) return { pincode: pin, city: null, state: 'Jammu & Kashmir', zone: 'ne_jk', serviceable: true, cod: false, rtoRate: 0.25, known: false };
  return { pincode: pin, city: null, state: null, zone: 'roi', serviceable: true, cod: true, rtoRate: 0.15, known: false };
}
