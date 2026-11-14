/**
 * Seeds Appendix A: catalogue, stock, pincodes and 30 orders covering every case the brief asks for.
 * Dates are relative to "now" so "delivered 3 days ago" stays true whenever you run it.
 * All names, phone numbers and addresses are made up.
 */
import { getDb, nowIso, resetDb } from '../db/index.js';
import { PINCODES, PRODUCTS, STOCK } from '../policy/catalog.js';
import { daysAgo } from '../lib/time.js';
import { createShipmentRecord } from '../courier/mockCourier.js';
import { insertOrder, computeRisk, updateOrder, type NewOrderInput } from './orders.js';
import { resetSettingsCache } from '../settings.js';

type Seed = Omit<NewOrderInput, 'source'> & {
  status: string; daysAgo: number; shippedDaysAgo?: number; deliveredDaysAgo?: number;
  ndr?: { attempts: number; reason: string }; courierTimeline?: string[]; codConfirmation?: string; cancelReason?: string; rtoReason?: string;
};

const A = (line1: string, pincode: string, landmark?: string) => ({ address_line1: line1, pincode, landmark: landmark ?? null });

export const SEED_ORDERS: Seed[] = [
  // --- unshipped
  { id: 'WL10230', name: 'Ananya Sharma', phone: '9810011001', email: 'ananya.s@example.com', ...A('B-42, Second Floor, Mayur Vihar Phase 1', '110092'), payment_method: 'prepaid', items: [{ sku: 'WL-KUR-01', size: 'M', qty: 1 }], status: 'confirmed', daysAgo: 0.4 },
  { id: 'WL10231', name: 'Rohan Mehta', phone: '9820022002', email: 'rohan.m@example.com', ...A('Flat 1204, Tower B, Hiranandani Gardens, Powai', '400076'), payment_method: 'cod', items: [{ sku: 'WL-TEE-02', size: 'L', qty: 1 }], status: 'pending_confirmation', daysAgo: 0.1, codConfirmation: 'pending' },
  { id: 'WL10232', name: 'Suresh Yadav', phone: '9935033003', ...A('near Shiv mandir, Rustampur', '273001'), payment_method: 'cod', items: [{ sku: 'WL-JNS-03', size: '32', qty: 2 }, { sku: 'WL-KUR-01', size: 'L', qty: 1 }], status: 'pending_confirmation', daysAgo: 0.05, codConfirmation: 'pending' },
  { id: 'WL10251', name: 'Gaurav Saxena', phone: '9450919019', ...A('Gali no 3, near water tank, Kankarbagh', '800001'), payment_method: 'cod', items: [{ sku: 'WL-JNS-03', size: '30', qty: 1 }], status: 'on_hold', daysAgo: 1.5, codConfirmation: 'on_hold' },
  { id: 'WL10252', name: 'Tanvi Shah', phone: '9825020020', ...A('402, Sea Breeze Apartments, Colaba Causeway', '400001'), payment_method: 'cod', items: [{ sku: 'WL-KUR-01', size: 'S', qty: 1 }, { sku: 'WL-BAG-05', size: 'ONE', qty: 1 }], status: 'confirmed', daysAgo: 0.3, codConfirmation: 'confirmed' },
  // --- in flight
  { id: 'WL10234', name: 'Rahul Verma', phone: '9876543210', email: 'rahul.v@example.com', ...A('House 17, Sector 12, Indira Nagar', '226010'), payment_method: 'prepaid', items: [{ sku: 'WL-KUR-01', size: 'M', qty: 1 }, { sku: 'WL-TEE-02', size: 'L', qty: 1 }], status: 'in_transit', daysAgo: 3, shippedDaysAgo: 2, courierTimeline: ['picked_up', 'in_transit'] },
  { id: 'WL10235', name: 'Priya Nair', phone: '9845044004', ...A('#55, 3rd Cross, Koramangala 5th Block', '560034'), payment_method: 'cod', items: [{ sku: 'WL-BAG-05', size: 'ONE', qty: 1 }], status: 'in_transit', daysAgo: 2, shippedDaysAgo: 1, courierTimeline: ['picked_up', 'in_transit'], codConfirmation: 'confirmed' },
  { id: 'WL10236', name: 'Amit Kumar', phone: '9871055005', ...A('C-9, Connaught Place', '110001'), payment_method: 'prepaid', items: [{ sku: 'WL-JNS-03', size: '32', qty: 1 }], status: 'out_for_delivery', daysAgo: 4, shippedDaysAgo: 3, courierTimeline: ['picked_up', 'in_transit', 'out_for_delivery'] },
  { id: 'WL10239', name: 'Sana Khan', phone: '9899123023', ...A('H.No 221, Okhla Vihar, Jamia Nagar', '110092'), payment_method: 'cod', items: [{ sku: 'WL-TEE-02', size: 'M', qty: 2 }], status: 'out_for_delivery', daysAgo: 3, shippedDaysAgo: 2, courierTimeline: ['picked_up', 'in_transit', 'out_for_delivery'], codConfirmation: 'confirmed' },
  { id: 'WL10254', name: 'Thoiba Singh', phone: '9862222022', ...A('Qtr 14, Uripok Polem Leikai', '795001'), payment_method: 'prepaid', items: [{ sku: 'WL-KUR-01', size: 'XXL', qty: 1 }], status: 'in_transit', daysAgo: 4, shippedDaysAgo: 3, courierTimeline: ['picked_up', 'in_transit'] },
  // --- failed deliveries
  { id: 'WL10242', name: 'Arjun Das', phone: '9831010110', ...A('12/1 Lake Road, Ballygunge', '700001'), payment_method: 'cod', items: [{ sku: 'WL-TEE-02', size: 'XL', qty: 1 }], status: 'delivery_failed', daysAgo: 5, shippedDaysAgo: 3, courierTimeline: ['picked_up', 'in_transit', 'out_for_delivery', 'delivery_failed'], ndr: { attempts: 1, reason: 'Customer not available' }, codConfirmation: 'confirmed' },
  { id: 'WL10243', name: 'Pooja Iyer', phone: '9840011211', ...A('Anna Nagar, near bus stop', '600001'), payment_method: 'cod', items: [{ sku: 'WL-KUR-01', size: 'S', qty: 1 }], status: 'delivery_failed', daysAgo: 7, shippedDaysAgo: 5, courierTimeline: ['picked_up', 'in_transit', 'out_for_delivery', 'delivery_failed', 'out_for_delivery', 'delivery_failed'], ndr: { attempts: 2, reason: 'Incomplete address' }, codConfirmation: 'confirmed' },
  { id: 'WL10244', name: 'Manish Tiwari', phone: '9792012312', ...A('Mohalla Bashartpur, near masjid', '273001'), payment_method: 'cod', items: [{ sku: 'WL-JNS-03', size: '34', qty: 1 }], status: 'rto_initiated', daysAgo: 9, shippedDaysAgo: 7, courierTimeline: ['picked_up', 'in_transit', 'out_for_delivery', 'delivery_failed', 'rto_initiated'], ndr: { attempts: 1, reason: 'Customer refused delivery' }, codConfirmation: 'confirmed', rtoReason: 'Customer refused delivery' },
  { id: 'WL10258', name: 'Manish Tiwari', phone: '9792012312', ...A('Mohalla Bashartpur, near masjid', '273001'), payment_method: 'cod', items: [{ sku: 'WL-TEE-02', size: 'L', qty: 1 }], status: 'rto_delivered', daysAgo: 40, shippedDaysAgo: 38, courierTimeline: ['picked_up', 'delivery_failed', 'rto_initiated', 'rto_delivered'], ndr: { attempts: 1, reason: 'Customer refused delivery' }, codConfirmation: 'confirmed', rtoReason: 'Customer refused delivery' },
  // --- delivered
  { id: 'WL10237', name: 'Vikram Singh', phone: '9839066006', ...A('22, Gomti Nagar Extension', '226010'), payment_method: 'prepaid', items: [{ sku: 'WL-KUR-01', size: 'M', qty: 1 }], status: 'delivered', daysAgo: 7, shippedDaysAgo: 5, deliveredDaysAgo: 3, courierTimeline: ['picked_up', 'in_transit', 'out_for_delivery', 'delivered'] },
  { id: 'WL10238', name: 'Neha Gupta', phone: '9818077007', ...A('E-14, Lajpat Nagar 2', '110092'), payment_method: 'prepaid', items: [{ sku: 'WL-TEE-02', size: 'M', qty: 1 }], status: 'delivered', daysAgo: 14, shippedDaysAgo: 12, deliveredDaysAgo: 10, courierTimeline: ['picked_up', 'in_transit', 'out_for_delivery', 'delivered'] },
  { id: 'WL10240', name: 'Karan Malhotra', phone: '9811088008', ...A('D-301, Raheja Residency, Sector 5', '110092'), payment_method: 'prepaid', items: [{ sku: 'WL-BRF-04', size: 'M', qty: 1 }], status: 'delivered', daysAgo: 6, shippedDaysAgo: 4, deliveredDaysAgo: 2, courierTimeline: ['picked_up', 'in_transit', 'out_for_delivery', 'delivered'] },
  { id: 'WL10241', name: 'Sneha Reddy', phone: '9849099009', ...A('Plot 88, Jubilee Hills Road 36', '500001'), payment_method: 'prepaid', items: [{ sku: 'WL-SAL-06', size: 'M', qty: 1 }], status: 'delivered', daysAgo: 6, shippedDaysAgo: 4, deliveredDaysAgo: 2, courierTimeline: ['picked_up', 'in_transit', 'out_for_delivery', 'delivered'] },
  { id: 'WL10245', name: 'Kavya Joshi', phone: '9829013413', ...A('14, Civil Lines, C-Scheme', '302001'), payment_method: 'prepaid', items: [{ sku: 'WL-TEE-02', size: 'S', qty: 1 }], status: 'delivered', daysAgo: 12, shippedDaysAgo: 10, deliveredDaysAgo: 6, courierTimeline: ['picked_up', 'in_transit', 'out_for_delivery', 'delivered'] },
  { id: 'WL10246', name: 'Deepak Chauhan', phone: '9826014514', ...A('B-7, Vijay Nagar Scheme 54', '452001'), payment_method: 'prepaid', items: [{ sku: 'WL-BAG-05', size: 'ONE', qty: 1 }], status: 'delivered', daysAgo: 26, shippedDaysAgo: 24, deliveredDaysAgo: 20, courierTimeline: ['picked_up', 'in_transit', 'out_for_delivery', 'delivered'] },
  { id: 'WL10247', name: 'Ritu Kapoor', phone: '9811515015', ...A('A-12, Defence Colony', '110092'), payment_method: 'prepaid', items: [{ sku: 'WL-KUR-01', size: 'S', qty: 1 }], status: 'delivered', daysAgo: 5, shippedDaysAgo: 4, deliveredDaysAgo: 2, courierTimeline: ['picked_up', 'in_transit', 'out_for_delivery', 'delivered'] },
  { id: 'WL10220', name: 'Ritu Kapoor', phone: '9811515015', ...A('A-12, Defence Colony', '110092'), payment_method: 'prepaid', items: [{ sku: 'WL-TEE-02', size: 'M', qty: 1 }], status: 'delivered', daysAgo: 52, deliveredDaysAgo: 48 },
  { id: 'WL10221', name: 'Ritu Kapoor', phone: '9811515015', ...A('A-12, Defence Colony', '110092'), payment_method: 'prepaid', items: [{ sku: 'WL-JNS-03', size: '28', qty: 1 }], status: 'delivered', daysAgo: 42, deliveredDaysAgo: 38 },
  { id: 'WL10222', name: 'Ritu Kapoor', phone: '9811515015', ...A('A-12, Defence Colony', '110092'), payment_method: 'prepaid', items: [{ sku: 'WL-KUR-01', size: 'M', qty: 1 }], status: 'delivered', daysAgo: 30, deliveredDaysAgo: 26 },
  { id: 'WL10248', name: 'Farhan Ali', phone: '9910616016', ...A('8-2-293, Road No 12, Banjara Hills', '500001'), payment_method: 'prepaid', items: [{ sku: 'WL-JNS-03', size: '34', qty: 1 }, { sku: 'WL-KUR-01', size: 'L', qty: 1 }], status: 'delivered', daysAgo: 8, shippedDaysAgo: 6, deliveredDaysAgo: 4, courierTimeline: ['picked_up', 'in_transit', 'out_for_delivery', 'delivered'] },
  { id: 'WL10249', name: 'Meera Pillai', phone: '9895717017', ...A('Flat 6, Prabhat Road, Lane 14', '411001'), payment_method: 'cod', items: [{ sku: 'WL-BAG-05', size: 'ONE', qty: 1 }], status: 'delivered', daysAgo: 5, shippedDaysAgo: 3, deliveredDaysAgo: 1, courierTimeline: ['picked_up', 'in_transit', 'out_for_delivery', 'delivered'], codConfirmation: 'confirmed' },
  { id: 'WL10253', name: 'Aditya Rao', phone: '9886121021', ...A('No. 4, MG Road, Ashok Nagar', '560001'), payment_method: 'prepaid', items: [{ sku: 'WL-KUR-01', size: 'L', qty: 1 }, { sku: 'WL-TEE-02', size: 'M', qty: 1 }], status: 'delivered', daysAgo: 9, shippedDaysAgo: 7, deliveredDaysAgo: 5, courierTimeline: ['picked_up', 'in_transit', 'out_for_delivery', 'delivered'] },
  { id: 'WL10255', name: 'Rohan Mehta', phone: '9820022002', ...A('Flat 1204, Tower B, Hiranandani Gardens, Powai', '400076'), payment_method: 'cod', items: [{ sku: 'WL-KUR-01', size: 'L', qty: 1 }], status: 'delivered', daysAgo: 80, deliveredDaysAgo: 76, codConfirmation: 'confirmed' },
  { id: 'WL10256', name: 'Rohan Mehta', phone: '9820022002', ...A('Flat 1204, Tower B, Hiranandani Gardens, Powai', '400076'), payment_method: 'prepaid', items: [{ sku: 'WL-JNS-03', size: '32', qty: 1 }], status: 'delivered', daysAgo: 45, deliveredDaysAgo: 41 },
  { id: 'WL10257', name: 'Rahul Verma', phone: '9876543210', ...A('House 17, Sector 12, Indira Nagar', '226010'), payment_method: 'prepaid', items: [{ sku: 'WL-TEE-02', size: 'M', qty: 1 }], status: 'delivered', daysAgo: 20, deliveredDaysAgo: 15 },
  // --- cancelled
  { id: 'WL10250', name: 'Ishaan Bose', phone: '9830818018', ...A('7B, Salt Lake Sector 1', '700001'), payment_method: 'prepaid', items: [{ sku: 'WL-TEE-02', size: 'S', qty: 1 }], status: 'cancelled', daysAgo: 6, cancelReason: 'Ordered by mistake' },
];

export function seed(opts: { reset?: boolean } = { reset: true }) {
  const db = getDb();
  if (opts.reset) resetDb();
  resetSettingsCache();
  const insP = db.prepare('INSERT OR REPLACE INTO products(sku,name,price,category,sizes,returnable,exchangeable,is_innerwear,is_sale,notes,description) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (const p of PRODUCTS) insP.run(p.sku, p.name, p.price, p.category, JSON.stringify(p.sizes), +p.returnable, +p.exchangeable, +p.isInnerwear, +p.isSale, p.notes, p.description);
  const insS = db.prepare('INSERT OR REPLACE INTO inventory(sku,size,qty) VALUES (?,?,?)');
  for (const [sku, sizes] of Object.entries(STOCK)) for (const [size, qty] of Object.entries(sizes)) insS.run(sku, size, qty);
  const insPin = db.prepare('INSERT OR REPLACE INTO pincodes(pincode,city,state,zone,serviceable,cod,rto_rate) VALUES (?,?,?,?,?,?,?)');
  for (const p of PINCODES) insPin.run(p.pincode, p.city, p.state, p.zone, +p.serviceable, +p.cod, p.rtoRate);

  // oldest first so customer history (repeat / RTO) is in place when risk is computed
  const ordered = [...SEED_ORDERS].sort((a, b) => b.daysAgo - a.daysAgo);
  for (const s of ordered) {
    const created = daysAgo(s.daysAgo);
    const { order } = insertOrder({ ...s, created_at: created, source: 'seed' }, {
      status: s.status,
      cod_confirmation: s.payment_method === 'cod' ? (s.codConfirmation ?? 'confirmed') : 'not_required',
      shipped_at: s.shippedDaysAgo != null ? daysAgo(s.shippedDaysAgo) : s.deliveredDaysAgo != null ? daysAgo(s.deliveredDaysAgo + 2) : null,
      delivered_at: s.deliveredDaysAgo != null ? daysAgo(s.deliveredDaysAgo) : null,
      ndr_attempts: s.ndr?.attempts ?? 0, ndr_reason: s.ndr?.reason ?? null, ndr_status: s.ndr ? (s.status === 'delivery_failed' ? 'open' : 'closed') : null,
      cancel_reason: s.cancelReason ?? null, rto_reason: s.rtoReason ?? null,
      confirmed_at: s.payment_method === 'cod' && s.codConfirmation !== 'pending' ? created : null,
      confirmation_sent_at: s.payment_method === 'cod' && s.status !== 'delivered' ? created : null,
    });
    if (s.payment_method === 'cod') {
      const r = computeRisk(order);
      db.prepare('UPDATE orders SET risk_score=?, risk_band=?, risk_reasons=? WHERE id=?').run(r.score, r.band, JSON.stringify(r.reasons), order.id);
    }
    if (s.courierTimeline) {
      const awb = createShipmentRecord(order.id, { name: s.name, phone: order.phone, address: s.address_line1, pincode: s.pincode }, daysAgo((s.shippedDaysAgo ?? 1) + 0.3));
      const start = s.shippedDaysAgo ?? 1;
      const end = s.deliveredDaysAgo ?? 0.1;
      const timeline = [{ at: daysAgo(start + 0.3), status: 'manifested', note: 'Shipment created', location: 'Wishluck warehouse, Delhi' }];
      const hubs = ['Wishluck warehouse, Delhi', 'Delhi hub', 'Lucknow hub', `${order.city ?? 'Destination'} delivery centre`, `${order.city ?? 'Destination'} delivery centre`, `${order.city ?? 'Destination'} delivery centre`];
      s.courierTimeline.forEach((st, i) => {
        const at = daysAgo(start - ((start - end) * (i + 1)) / s.courierTimeline!.length);
        const note = st === 'delivery_failed' ? (i === s.courierTimeline!.length - 1 ? s.ndr?.reason : 'Customer not available') : undefined;
        timeline.push({ at, status: st, note, location: hubs[Math.min(i + 1, hubs.length - 1)] } as any);
      });
      const attempts = s.courierTimeline.filter((x) => x === 'delivery_failed').length;
      db.prepare('UPDATE courier_shipments SET status=?, attempts=?, timeline=? WHERE awb=?').run(s.courierTimeline[s.courierTimeline.length - 1], attempts, JSON.stringify(timeline), awb);
      db.prepare('UPDATE orders SET awb=?, courier=? WHERE id=?').run(awb, 'SwiftShip', order.id);
    }
  }

  // Ritu Kapoor: 3 returns in the last 60 days (→ manual review)
  const insR = db.prepare(`INSERT INTO returns(id,order_id,item_id,phone,type,reason,new_size,status,refund_amount,refund_method,dedupe_key,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insR.run('RET-7001A', 'WL10220', 'WL10220-1', '9811515015', 'return', 'Did not like the colour', null, 'completed', 699, 'original_payment_method', 'seed-1', 'seed', daysAgo(45));
  insR.run('RET-7002B', 'WL10221', 'WL10221-1', '9811515015', 'return', 'Fit too tight', null, 'completed', 1799, 'original_payment_method', 'seed-2', 'seed', daysAgo(35));
  insR.run('RET-7003C', 'WL10222', 'WL10222-1', '9811515015', 'return', 'Changed my mind', null, 'completed', 1299, 'original_payment_method', 'seed-3', 'seed', daysAgo(24));
  // Refund pending (QC passed yesterday) and refund done
  insR.run('RET-7104D', 'WL10245', 'WL10245-1', '9829013413', 'return', 'Size too small', null, 'approved', 699, 'original_payment_method', 'seed-4', 'seed', daysAgo(5));
  insR.run('RET-7105E', 'WL10246', 'WL10246-1', '9826014514', 'return', 'Not as expected', null, 'completed', 899, 'original_payment_method', 'seed-5', 'seed', daysAgo(18));
  const insF = db.prepare(`INSERT INTO refunds(id,order_id,return_id,amount,method,status,reference,initiated_at,qc_passed_at,processed_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  insF.run('RFD-8001A', 'WL10245', 'RET-7104D', 699, 'original_payment_method', 'pending', null, daysAgo(5), daysAgo(1), null);
  insF.run('RFD-8002B', 'WL10246', 'RET-7105E', 899, 'original_payment_method', 'processed', 'UTR2611048831', daysAgo(18), daysAgo(12), daysAgo(5));
  for (const id of ['WL10220', 'WL10221', 'WL10222']) db.prepare('UPDATE order_items SET exchange_count=0 WHERE order_id=?').run(id);

  db.prepare(`INSERT INTO audit_log(entity_type,entity_id,field,old_value,new_value,actor,reason,created_at) VALUES ('system','seed','seeded',NULL,?, 'system','seed script',?)`).run(String(SEED_ORDERS.length), nowIso());
  return { orders: SEED_ORDERS.length, products: PRODUCTS.length };
}

export { updateOrder };
