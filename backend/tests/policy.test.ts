import { describe, expect, it } from 'vitest';
import { productBySku } from '../src/policy/catalog.js';
import { addWorkingDays, evaluateAddressChange, evaluateCancellation, evaluateCod, evaluateExchange, evaluateReturn, prepaidQuote, shippingFee } from '../src/policy/policy.js';

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 15, 6);
const delivered = (days: number, extra: any = {}) => ({ id: 'WL1', status: 'delivered', payment_method: 'prepaid', subtotal: 1299, total: 1299, delivered_at: new Date(now - days * DAY).toISOString(), ...extra });
const item = (sku: string, extra: any = {}) => ({ id: 'WL1-1', sku, size: 'M', qty: 1, price: productBySku(sku)!.price, exchange_count: 0, ...extra });

describe('returns', () => {
  const base = { now, returnsLast60Days: 0 };
  it('approves a kurta within 7 days with refund to source for prepaid', () => {
    const d = evaluateReturn({ ...base, order: delivered(3), item: item('WL-KUR-01'), product: productBySku('WL-KUR-01')! });
    expect(d.outcome).toBe('approve');
    expect(d.refundAmount).toBe(1299);
    expect(d.refundMethodOptions).toEqual(['original_payment_method']);
  });
  it('offers bank transfer / store credit for COD orders', () => {
    const d = evaluateReturn({ ...base, order: delivered(1, { payment_method: 'cod' }), item: item('WL-BAG-05', { size: 'ONE' }), product: productBySku('WL-BAG-05')! });
    expect(d.refundMethodOptions).toEqual(['bank_transfer', 'store_credit']);
  });
  it('rejects innerwear', () => {
    const d = evaluateReturn({ ...base, order: delivered(2), item: item('WL-BRF-04'), product: productBySku('WL-BRF-04')! });
    expect(d).toMatchObject({ allowed: false, code: 'INNERWEAR_NON_RETURNABLE' });
  });
  it('rejects refunds on sale items but offers a size exchange', () => {
    const d = evaluateReturn({ ...base, order: delivered(2), item: item('WL-SAL-06'), product: productBySku('WL-SAL-06')! });
    expect(d.code).toBe('SALE_EXCHANGE_ONLY');
    expect(d.alternatives).toContain('size_exchange');
  });
  it('rejects after the 7-day window (day 8) and accepts on day 7', () => {
    expect(evaluateReturn({ ...base, order: delivered(8), item: item('WL-TEE-02'), product: productBySku('WL-TEE-02')! }).code).toBe('WINDOW_EXPIRED');
    expect(evaluateReturn({ ...base, order: delivered(7), item: item('WL-TEE-02'), product: productBySku('WL-TEE-02')! }).allowed).toBe(true);
  });
  it('sends refunds above ₹1,500 to manual review', () => {
    const d = evaluateReturn({ ...base, order: delivered(2), item: item('WL-JNS-03', { size: '32' }), product: productBySku('WL-JNS-03')! });
    expect(d.outcome).toBe('manual_review');
    expect(d.manualReviewReasons?.[0]).toMatch(/1,799/);
  });
  it('sends damage claims without photo and 3+ returns in 60 days to manual review', () => {
    expect(evaluateReturn({ ...base, order: delivered(2), item: item('WL-TEE-02'), product: productBySku('WL-TEE-02')!, isDamageClaim: true, hasPhoto: false }).outcome).toBe('manual_review');
    expect(evaluateReturn({ ...base, order: delivered(2), item: item('WL-TEE-02'), product: productBySku('WL-TEE-02')!, isDamageClaim: true, hasPhoto: true }).outcome).toBe('approve');
    expect(evaluateReturn({ ...base, returnsLast60Days: 3, order: delivered(2), item: item('WL-TEE-02'), product: productBySku('WL-TEE-02')! }).outcome).toBe('manual_review');
  });
  it('rejects returns before delivery and duplicates', () => {
    expect(evaluateReturn({ ...base, order: { ...delivered(0), status: 'in_transit' }, item: item('WL-TEE-02'), product: productBySku('WL-TEE-02')! }).alternatives).toContain('refuse_delivery');
    expect(evaluateReturn({ ...base, hasActiveRequest: true, order: delivered(1), item: item('WL-TEE-02'), product: productBySku('WL-TEE-02')! }).code).toBe('DUPLICATE_REQUEST');
  });
});

describe('exchanges', () => {
  const kurta = productBySku('WL-KUR-01')!;
  it('approves M → L when in stock', () => {
    expect(evaluateExchange({ now, order: delivered(3), item: item('WL-KUR-01'), product: kurta, newSize: 'L', stockQty: 4 }).outcome).toBe('approve');
  });
  it('rejects out of stock, same size, unknown size, second exchange', () => {
    expect(evaluateExchange({ now, order: delivered(3), item: item('WL-KUR-01'), product: kurta, newSize: 'XL', stockQty: 0 }).code).toBe('OUT_OF_STOCK');
    expect(evaluateExchange({ now, order: delivered(3), item: item('WL-KUR-01'), product: kurta, newSize: 'M', stockQty: 5 }).code).toBe('SAME_SIZE');
    expect(evaluateExchange({ now, order: delivered(3), item: item('WL-KUR-01'), product: kurta, newSize: 'XS', stockQty: 5 }).code).toBe('INVALID_SIZE');
    expect(evaluateExchange({ now, order: delivered(3), item: item('WL-KUR-01', { exchange_count: 1 }), product: kurta, newSize: 'L', stockQty: 5 }).code).toBe('EXCHANGE_LIMIT');
  });
  it('allows size exchange on sale items, not on totes or innerwear', () => {
    expect(evaluateExchange({ now, order: delivered(2), item: item('WL-SAL-06'), product: productBySku('WL-SAL-06')!, newSize: 'L', stockQty: 3 }).allowed).toBe(true);
    expect(evaluateExchange({ now, order: delivered(2), item: item('WL-BAG-05', { size: 'ONE' }), product: productBySku('WL-BAG-05')!, newSize: 'ONE', stockQty: 3 }).code).toBe('NOT_EXCHANGEABLE');
    expect(evaluateExchange({ now, order: delivered(2), item: item('WL-BRF-04'), product: productBySku('WL-BRF-04')!, newSize: 'L', stockQty: 3 }).code).toBe('INNERWEAR_NON_RETURNABLE');
  });
});

describe('cancellation', () => {
  it('is free before shipping (prepaid gets full refund)', () => {
    const d = evaluateCancellation({ id: 'x', status: 'confirmed', payment_method: 'prepaid', subtotal: 1299, total: 1378 });
    expect(d).toMatchObject({ allowed: true, refundAmount: 1378 });
  });
  it('after shipping: refuse at door (prepaid refund minus ₹99) or return', () => {
    const d = evaluateCancellation({ id: 'x', status: 'in_transit', payment_method: 'prepaid', subtotal: 1299, total: 1299 });
    expect(d.allowed).toBe(false);
    expect(d.refundAmount).toBe(1200);
    expect(d.alternatives).toEqual(['refuse_delivery', 'return_after_delivery']);
  });
});

describe('COD, shipping, address', () => {
  const pin = (o: any = {}) => ({ pincode: '226010', city: 'Lucknow', state: 'UP', zone: 'roi' as const, serviceable: true, cod: true, rtoRate: 0.1, known: true, ...o });
  it('COD only between ₹299 and ₹4,999 on COD pincodes', () => {
    expect(evaluateCod(299, pin()).allowed).toBe(true);
    expect(evaluateCod(4999, pin()).allowed).toBe(true);
    expect(evaluateCod(298, pin()).allowed).toBe(false);
    expect(evaluateCod(5000, pin()).allowed).toBe(false);
    expect(evaluateCod(1000, pin({ cod: false })).allowed).toBe(false);
  });
  it('shipping free above ₹999 else ₹79', () => {
    expect(shippingFee(999)).toBe(79);
    expect(shippingFee(1000)).toBe(0);
  });
  it('prepaid quote = 5% off subtotal, COD fee removed', () => {
    expect(prepaidQuote({ subtotal: 2598, shipping_fee: 0, discount: 0 })).toEqual({ discount: 130, payable: 2468 });
  });
  it('address change only before dispatch, serviceable and COD-enabled for COD orders', () => {
    const o = { id: 'x', status: 'pending_confirmation', payment_method: 'cod', subtotal: 1, total: 1 };
    expect(evaluateAddressChange(o, pin()).allowed).toBe(true);
    expect(evaluateAddressChange(o, pin({ cod: false })).code).toBe('COD_NOT_AVAILABLE');
    expect(evaluateAddressChange(o, pin({ serviceable: false })).code).toBe('NOT_SERVICEABLE');
    expect(evaluateAddressChange({ ...o, status: 'in_transit' }, pin()).code).toBe('ALREADY_DISPATCHED');
  });
  it('refund window counts working days', () => {
    expect(addWorkingDays('2026-11-13T10:00:00Z', 5).slice(0, 10)).toBe('2026-11-20'); // Fri + 5 working days
  });
});
