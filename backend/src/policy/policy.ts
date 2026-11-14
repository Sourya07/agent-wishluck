/**
 * Store policy (Appendix A) as plain, deterministic functions.
 * The LLM never decides eligibility — it only explains the decision returned from here.
 * Every function is pure (inputs in, decision out) so it is unit-tested in isolation.
 */
import type { PincodeInfo, Product, Zone } from './catalog.js';

export const POLICY = {
  returnWindowDays: 7,
  exchangeWindowDays: 7,
  maxExchangesPerItem: 1,
  refuseDeliveryShippingDeduction: 99,
  refundWorkingDays: [5, 7] as const,
  cod: { min: 299, max: 4999, fee: 49, prepaidDiscountPct: 5 },
  shipping: { freeAbove: 999, fee: 79 },
  eta: { metro: [2, 4], roi: [4, 7], ne_jk: [6, 9] } as Record<Zone, [number, number]>,
  manualReview: { refundAbove: 1500, returnsIn60Days: 3 },
};

export type OrderStatus =
  | 'pending_confirmation' | 'confirmed' | 'on_hold' | 'shipped' | 'in_transit' | 'out_for_delivery'
  | 'delivery_failed' | 'delivered' | 'rto_initiated' | 'rto_delivered' | 'cancelled';

export const PRE_DISPATCH: OrderStatus[] = ['pending_confirmation', 'confirmed', 'on_hold'];
export const IN_FLIGHT: OrderStatus[] = ['shipped', 'in_transit', 'out_for_delivery', 'delivery_failed'];

export interface OrderLike {
  id: string; status: OrderStatus | string; payment_method: 'cod' | 'prepaid' | string;
  subtotal: number; total: number; delivered_at?: string | null;
}
export interface ItemLike { id: string; sku: string; size?: string | null; qty: number; price: number; exchange_count: number }

export interface Decision {
  allowed: boolean;
  /** approve | reject | manual_review */
  outcome: 'approve' | 'reject' | 'manual_review';
  code: string;
  /** Plain-English reasons the agent can relay. */
  reasons: string[];
  /** Alternatives the agent may offer (e.g. size exchange instead of refund). */
  alternatives: string[];
  refundAmount?: number;
  refundMethodOptions?: string[];
  refundTimeline?: string;
  manualReviewReasons?: string[];
}

const DAY = 86_400_000;
const rs = (n: number): string => `₹${Math.round(n).toLocaleString('en-IN')}`;
export const daysSince = (iso: string | null | undefined, now: number) =>
  iso ? Math.floor((now - new Date(iso).getTime()) / DAY) : Infinity;

function refundMethods(order: OrderLike) {
  return order.payment_method === 'prepaid'
    ? { options: ['original_payment_method'], timeline: `Refund to the original payment method within ${POLICY.refundWorkingDays[0]}-${POLICY.refundWorkingDays[1]} working days after the returned item passes quality check.` }
    : { options: ['bank_transfer', 'store_credit'], timeline: `COD orders are refunded by bank transfer or store credit (customer's choice) within ${POLICY.refundWorkingDays[0]}-${POLICY.refundWorkingDays[1]} working days after the returned item passes quality check.` };
}

export interface ReturnInput {
  order: OrderLike; item: ItemLike; product: Product; now?: number;
  /** returns+exchanges this customer raised in the last 60 days (excluding this one) */
  returnsLast60Days: number;
  /** true if there is already an open/approved return or exchange for this item */
  hasActiveRequest?: boolean;
  isDamageClaim?: boolean; hasPhoto?: boolean;
  refundLimit?: number;
}

export function evaluateReturn(input: ReturnInput): Decision {
  const { order, item, product, returnsLast60Days, hasActiveRequest, isDamageClaim, hasPhoto } = input;
  const now = input.now ?? Date.now();
  const limit = input.refundLimit ?? POLICY.manualReview.refundAbove;
  const reject = (code: string, reasons: string[], alternatives: string[] = []): Decision => ({ allowed: false, outcome: 'reject', code, reasons, alternatives });

  if (order.status !== 'delivered') {
    const alt = PRE_DISPATCH.includes(order.status as OrderStatus) ? ['cancel_order'] : IN_FLIGHT.includes(order.status as OrderStatus) ? ['refuse_delivery'] : [];
    return reject('NOT_DELIVERED', ['Returns can only be raised after the order is delivered.'], alt);
  }
  if (hasActiveRequest) return reject('DUPLICATE_REQUEST', ['There is already a return or exchange request for this item.']);
  if (product.isInnerwear) return reject('INNERWEAR_NON_RETURNABLE', ['Innerwear cannot be returned for hygiene reasons.']);
  const age = daysSince(order.delivered_at, now);
  if (age > POLICY.returnWindowDays) return reject('WINDOW_EXPIRED', [`Returns are accepted within ${POLICY.returnWindowDays} days of delivery; this item was delivered ${age} days ago.`]);
  if (product.isSale) {
    const canExchange = item.exchange_count < POLICY.maxExchangesPerItem;
    return reject('SALE_EXCHANGE_ONLY', ['Sale items cannot be refunded — they can only be exchanged for another size.'], canExchange ? ['size_exchange'] : []);
  }
  if (!product.returnable) return reject('NOT_RETURNABLE', [`${product.name} is not returnable.`]);

  const refundAmount = item.price * item.qty;
  const rm = refundMethods(order);
  const review: string[] = [];
  if (refundAmount > limit) review.push(`Refund amount ${rs(refundAmount)} is above ${rs(limit)}.`);
  if (isDamageClaim && !hasPhoto) review.push('Damage claim without a photo.');
  if (returnsLast60Days >= POLICY.manualReview.returnsIn60Days) review.push(`Customer has ${returnsLast60Days} returns in the last 60 days.`);

  const base = {
    refundAmount, refundMethodOptions: rm.options, refundTimeline: rm.timeline,
    alternatives: product.exchangeable && item.exchange_count < POLICY.maxExchangesPerItem ? ['size_exchange'] : [],
  };
  if (review.length) {
    return { allowed: true, outcome: 'manual_review', code: 'MANUAL_REVIEW', reasons: ['This return needs a quick manual review by our team.'], manualReviewReasons: review, ...base };
  }
  return { allowed: true, outcome: 'approve', code: 'RETURN_ELIGIBLE', reasons: [`Eligible: delivered ${age} day(s) ago, within the ${POLICY.returnWindowDays}-day window. Item must be unused with tags.`], ...base };
}

export interface ExchangeInput {
  order: OrderLike; item: ItemLike; product: Product; newSize: string; stockQty: number; now?: number;
  returnsLast60Days?: number; hasActiveRequest?: boolean;
}

export function evaluateExchange(input: ExchangeInput): Decision {
  const { order, item, product, stockQty, hasActiveRequest } = input;
  const newSize = String(input.newSize).toUpperCase();
  const now = input.now ?? Date.now();
  const reject = (code: string, reasons: string[], alternatives: string[] = []): Decision => ({ allowed: false, outcome: 'reject', code, reasons, alternatives });

  if (order.status !== 'delivered') return reject('NOT_DELIVERED', ['Exchanges can only be raised after the order is delivered.']);
  if (hasActiveRequest) return reject('DUPLICATE_REQUEST', ['There is already a return or exchange request for this item.']);
  if (!product.exchangeable) {
    return reject(product.isInnerwear ? 'INNERWEAR_NON_RETURNABLE' : 'NOT_EXCHANGEABLE', [product.isInnerwear ? 'Innerwear cannot be returned or exchanged for hygiene reasons.' : `${product.name} can be returned but not exchanged.`], product.returnable ? ['return'] : []);
  }
  const age = daysSince(order.delivered_at, now);
  if (age > POLICY.exchangeWindowDays) return reject('WINDOW_EXPIRED', [`Size exchanges are allowed within ${POLICY.exchangeWindowDays} days of delivery; this item was delivered ${age} days ago.`]);
  if (item.exchange_count >= POLICY.maxExchangesPerItem) return reject('EXCHANGE_LIMIT', ['Only one exchange is allowed per item and this item has already been exchanged.']);
  if (!product.sizes.includes(newSize)) return reject('INVALID_SIZE', [`${product.name} comes in sizes ${product.sizes.join(', ')}.`]);
  if (item.size && item.size.toUpperCase() === newSize) return reject('SAME_SIZE', [`The item is already size ${newSize}.`]);
  if (stockQty <= 0) return reject('OUT_OF_STOCK', [`Size ${newSize} is currently out of stock.`], product.returnable && !product.isSale ? ['return'] : []);

  const review: string[] = [];
  if ((input.returnsLast60Days ?? 0) >= POLICY.manualReview.returnsIn60Days) review.push(`Customer has ${input.returnsLast60Days} returns in the last 60 days.`);
  if (review.length) return { allowed: true, outcome: 'manual_review', code: 'MANUAL_REVIEW', reasons: ['This exchange needs a quick manual review by our team.'], alternatives: [], manualReviewReasons: review };
  return { allowed: true, outcome: 'approve', code: 'EXCHANGE_ELIGIBLE', reasons: [`Eligible: delivered ${age} day(s) ago, size ${newSize} is in stock, first exchange for this item.`], alternatives: [] };
}

export function evaluateCancellation(order: OrderLike): Decision {
  const s = order.status as OrderStatus;
  if (s === 'cancelled') return { allowed: false, outcome: 'reject', code: 'ALREADY_CANCELLED', reasons: ['This order is already cancelled.'], alternatives: [] };
  if (PRE_DISPATCH.includes(s)) {
    return {
      allowed: true, outcome: 'approve', code: 'CANCEL_FREE',
      reasons: ['The order has not shipped yet, so it can be cancelled free of charge.'],
      alternatives: [],
      refundAmount: order.payment_method === 'prepaid' ? order.total : 0,
      refundTimeline: order.payment_method === 'prepaid' ? `Full refund of ${rs(order.total)} to the original payment method in ${POLICY.refundWorkingDays[0]}-${POLICY.refundWorkingDays[1]} working days.` : 'Nothing was paid (COD), so there is no refund to process.',
    };
  }
  if (IN_FLIGHT.includes(s)) {
    const refused = order.payment_method === 'prepaid' ? Math.max(0, order.total - POLICY.refuseDeliveryShippingDeduction) : 0;
    return {
      allowed: false, outcome: 'reject', code: 'ALREADY_SHIPPED',
      reasons: ['The order has already shipped, so it can no longer be cancelled.'],
      alternatives: ['refuse_delivery', 'return_after_delivery'],
      refundAmount: refused,
      refundTimeline: order.payment_method === 'prepaid'
        ? `If you refuse the delivery, you get ${rs(refused)} back (order total minus ${rs(POLICY.refuseDeliveryShippingDeduction)} shipping) after the parcel returns to us. Or accept it and raise a return within ${POLICY.returnWindowDays} days of delivery (where the item is returnable).`
        : `You can refuse the parcel at the door (nothing to pay on COD), or accept it and raise a return within ${POLICY.returnWindowDays} days of delivery (where the item is returnable).`,
    };
  }
  if (s === 'delivered') return { allowed: false, outcome: 'reject', code: 'ALREADY_DELIVERED', reasons: ['The order is already delivered — it can be returned instead, if the item is returnable.'], alternatives: ['return_after_delivery'] };
  return { allowed: false, outcome: 'reject', code: 'NOT_CANCELLABLE', reasons: [`Orders in status "${s}" cannot be cancelled.`], alternatives: [] };
}

export function evaluateAddressChange(order: OrderLike, pin: PincodeInfo | null): Decision {
  const s = order.status as OrderStatus;
  if (!PRE_DISPATCH.includes(s)) return { allowed: false, outcome: 'reject', code: 'ALREADY_DISPATCHED', reasons: ['The address can only be changed before the order is dispatched.'], alternatives: IN_FLIGHT.includes(s) ? ['courier_instructions'] : [] };
  if (!pin) return { allowed: false, outcome: 'reject', code: 'INVALID_PINCODE', reasons: ['Please share a valid 6-digit pincode.'], alternatives: [] };
  if (!pin.serviceable) return { allowed: false, outcome: 'reject', code: 'NOT_SERVICEABLE', reasons: [`We do not deliver to pincode ${pin.pincode} yet.`], alternatives: [] };
  if (order.payment_method === 'cod' && !pin.cod) return { allowed: false, outcome: 'reject', code: 'COD_NOT_AVAILABLE', reasons: [`Pincode ${pin.pincode} is serviceable but COD is not available there.`], alternatives: ['switch_to_prepaid'] };
  return { allowed: true, outcome: 'approve', code: 'ADDRESS_CHANGE_OK', reasons: [`Pincode ${pin.pincode} is serviceable${order.payment_method === 'cod' ? ' with COD' : ''}.`], alternatives: [] };
}

export function evaluateCod(orderValue: number, pin: PincodeInfo | null) {
  const reasons: string[] = [];
  if (!pin || !pin.serviceable) reasons.push(pin ? `We do not deliver to ${pin.pincode}.` : 'Invalid pincode.');
  else if (!pin.cod) reasons.push(`Cash on delivery is not available for pincode ${pin.pincode}.`);
  if (orderValue < POLICY.cod.min || orderValue > POLICY.cod.max) reasons.push(`COD is available for orders between ${rs(POLICY.cod.min)} and ${rs(POLICY.cod.max)}.`);
  return { allowed: reasons.length === 0, codFee: POLICY.cod.fee, prepaidDiscountPct: POLICY.cod.prepaidDiscountPct, reasons };
}

export const shippingFee = (subtotal: number) => (subtotal > POLICY.shipping.freeAbove ? 0 : POLICY.shipping.fee);

export function etaWindow(zone: Zone, fromIso: string) {
  const [a, b] = POLICY.eta[zone];
  const from = new Date(fromIso).getTime();
  return { from: new Date(from + a * 86_400_000).toISOString(), to: new Date(from + b * 86_400_000).toISOString(), days: [a, b] as [number, number] };
}

/** Prepaid conversion: 5% off the item subtotal, COD fee waived. */
export function prepaidQuote(o: { subtotal: number; shipping_fee: number; discount: number }) {
  const discount = Math.round((o.subtotal * POLICY.cod.prepaidDiscountPct) / 100);
  return { discount, payable: o.subtotal + o.shipping_fee - (o.discount || 0) - discount };
}

/** Adds working days (Mon–Fri) to a date. */
export function addWorkingDays(iso: string, n: number) {
  const d = new Date(iso);
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d.toISOString();
}

export function refundWindow(qcPassedAt: string) {
  return { from: addWorkingDays(qcPassedAt, POLICY.refundWorkingDays[0]), to: addWorkingDays(qcPassedAt, POLICY.refundWorkingDays[1]) };
}

/** Whether a refund/goodwill request needs manual review (> ₹1,500 by default). */
export const needsManualReviewForAmount = (amount: number, limit = POLICY.manualReview.refundAbove) => amount > limit;
