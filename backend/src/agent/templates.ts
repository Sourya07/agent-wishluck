/**
 * Customer-facing copy in English, Hinglish and Hindi.
 * Used by the deterministic flows (COD confirmation, NDR, confirmations) and the rule-based fallback agent.
 * Every number/date that appears here is passed in from a tool result — templates never invent facts.
 */
import type { Lang } from './nlu.js';
import { fmtDate, inr } from '../lib/time.js';

export interface Button { id: string; label: string }
export interface Reply { text: string; buttons?: Button[] }

type Dict = Record<string, (v: any) => string>;

const STATUS: Record<Lang, Record<string, string>> = {
  en: {
    pending_confirmation: 'waiting for your confirmation', confirmed: 'confirmed and being packed', on_hold: 'on hold', shipped: 'shipped',
    in_transit: 'in transit', out_for_delivery: 'out for delivery today', delivery_failed: 'a delivery attempt failed', delivered: 'delivered',
    rto_initiated: 'being returned to us', rto_delivered: 'returned to us', cancelled: 'cancelled', manifested: 'packed and ready for pickup', picked_up: 'picked up by the courier',
  },
  hinglish: {
    pending_confirmation: 'aapke confirmation ka wait kar raha hai', confirmed: 'confirm ho gaya hai aur pack ho raha hai', on_hold: 'hold par hai', shipped: 'ship ho gaya hai',
    in_transit: 'raste mein hai (in transit)', out_for_delivery: 'aaj delivery ke liye nikla hai', delivery_failed: 'ki delivery attempt fail hui hai', delivered: 'deliver ho chuka hai',
    rto_initiated: 'wapas hamare paas aa raha hai', rto_delivered: 'wapas aa chuka hai', cancelled: 'cancel ho chuka hai', manifested: 'pack ho gaya hai, pickup ka wait hai', picked_up: 'courier ne pick kar liya hai',
  },
  hi: {
    pending_confirmation: 'आपकी पुष्टि का इंतज़ार कर रहा है', confirmed: 'कन्फ़र्म हो गया है और पैक हो रहा है', on_hold: 'होल्ड पर है', shipped: 'शिप हो गया है',
    in_transit: 'रास्ते में है', out_for_delivery: 'आज डिलीवरी के लिए निकला है', delivery_failed: 'की डिलीवरी कोशिश असफल रही', delivered: 'डिलीवर हो चुका है',
    rto_initiated: 'हमारे पास वापस आ रहा है', rto_delivered: 'वापस आ चुका है', cancelled: 'कैंसल हो चुका है', manifested: 'पैक हो गया है', picked_up: 'कूरियर ने उठा लिया है',
  },
};
export const statusLabel = (lang: Lang, s: string) => STATUS[lang][s] ?? STATUS.en[s] ?? s.replace(/_/g, ' ');

const items = (o: any) => (o.items ?? []).map((i: any) => `${i.name}${i.size && i.size !== 'ONE' ? ` (${i.size})` : ''} × ${i.qty}`).join(', ');

const en: Dict = {
  greeting: () => 'Hi! I am the Wishluck support assistant. I can help with order tracking, cancellations, returns & exchanges, refunds, sizes and our policies. How can I help?',
  ask_verify: () => 'Sure, I can help with that. To keep your details safe, please share your order ID (it starts with WL, e.g. WL1XXXX) and the phone number used on the order.',
  ask_phone: (v) => `Thanks. Please also share the phone number used on order ${v.orderId} so I can verify it's you.`,
  ask_order_id: () => 'Thanks. Please also share your order ID (it starts with WL, e.g. WL1XXXX).',
  verify_failed: () => "Sorry, that order ID and phone number don't match our records, so I can't share any order details. Please check both and send them again.",
  verify_locked: () => "I couldn't verify these details after several attempts. For your security I'm connecting you with our support team.",
  order_status: (v) => {
    const o = v.order; const t = v.tracking;
    let s = `Order ${o.id} (${items(o)}) is ${statusLabel('en', t?.current_status ?? o.status)}.`;
    if (t?.last_update?.location) s += ` Last update: ${t.last_update.location}${t.last_update.at ? `, ${fmtDate(t.last_update.at)}` : ''}.`;
    if (t?.scheduled_date) s += ` Re-attempt scheduled for ${fmtDate(t.scheduled_date)}.`;
    if (o.status !== 'delivered' && o.status !== 'cancelled' && o.eta_from) s += ` Expected delivery: ${fmtDate(o.eta_from)} – ${fmtDate(o.eta_to)}.`;
    if (o.status === 'delivered' && o.delivered_on) s += ` Delivered on ${fmtDate(o.delivered_on)}.`;
    if (t?.tracking_url) s += `\nTrack it here: ${t.tracking_url}`;
    return s;
  },
  tool_down: () => "I couldn't fetch the live details right now — our systems are not responding. Would you like a callback from our team? Reply \"callback\" and someone will call you.",
  callback_created: () => 'Done — I have requested a callback. Someone from our team will call you on your registered number.',
  cancel_q: (v) => `Just to confirm: I'm about to cancel order ${v.order.id} (${items(v.order)}, ${inr(v.order.total)}). ${v.refundNote ?? ''} Shall I go ahead?`,
  cancel_done: (v) => `Order ${v.orderId} has been cancelled. ${v.refundNote ?? ''}`,
  cancel_shipped: (v) => `Order ${v.orderId} has already shipped, so it can't be cancelled now. ${v.note}`,
  cancel_other: (v) => `I can't cancel order ${v.orderId}: ${v.reason}`,
  return_rejected: (v) => `I'm sorry, ${v.item} can't be returned: ${v.reason}${v.exchange ? ' I can arrange a size exchange instead — which size would you like?' : ''}`,
  return_q: (v) => `Just to confirm: I'll raise a return for ${v.item} from order ${v.orderId}. Refund: ${inr(v.amount)} ${v.methodText}. The item must be unused with tags; our pickup partner will collect it. Shall I go ahead?`,
  return_done: (v) => `Your return request ${v.returnId} is created. ${v.timeline}`,
  return_review_q: (v) => `This return (${v.item}, ${inr(v.amount)}) needs a quick manual review by our team as per policy. Shall I raise it for review?`,
  ask_refund_method: () => 'Since this was a COD order, how would you like your refund — bank transfer or store credit?',
  exchange_q: (v) => `Just to confirm: I'll exchange your ${v.item} from size ${v.from} to size ${v.to} (in stock) on order ${v.orderId}. Please keep the item unused with tags for pickup. Shall I go ahead?`,
  exchange_done: (v) => `Done! Exchange ${v.returnId} is created — we'll pick up the ${v.from} and send size ${v.to}.`,
  exchange_rejected: (v) => `Sorry, I can't exchange this item: ${v.reason}`,
  ask_size: (v) => `Which size would you like instead? ${v.item} comes in ${v.sizes}.`,
  ask_item: (v) => `Which item is this about? Your order has: ${v.items}.`,
  address_ask: () => 'Please send the full new address with house/flat number, street, area, landmark and the 6-digit pincode.',
  address_q: (v) => `Just to confirm: I'll change the delivery address of order ${v.orderId} to "${v.address}" (pincode ${v.pincode}). Shall I go ahead?`,
  address_done: (v) => `Done — the delivery address for order ${v.orderId} is updated.`,
  address_rejected: (v) => `I can't change the address: ${v.reason}`,
  address_unclear: () => "I couldn't find a valid 6-digit pincode in that address. Please send the full address including the pincode.",
  refund_status: (v) => v.refunds.length
    ? v.refunds.map((r: any) => r.status === 'processed'
      ? `Your refund of ${inr(r.amount)} for order ${v.orderId} was processed on ${fmtDate(r.processed_on)} via ${r.method_label}${r.reference ? ` (ref ${r.reference})` : ''}.`
      : `Your refund of ${inr(r.amount)} for order ${v.orderId} is ${r.status_label}. ${r.expected_text}`).join('\n')
    : `There's no refund on order ${v.orderId}${v.returns?.length ? ` yet — your return is ${v.returns[0].status.replace('_', ' ')}` : ''}.`,
  size_advice: (v) => v.recommended
    ? `For ${v.product}, I'd suggest size ${v.recommended}${v.alternatives?.length ? ` (or ${v.alternatives.join('/')} if you prefer a looser fit)` : ''}, based on our size chart.${v.note ? ' ' + v.note : ''}`
    : `Could you share your height and weight (for example 5'8", 70 kg) so I can check the ${v.product} size chart?`,
  pincode_cod: (v) => !v.serviceable
    ? `Sorry, we don't deliver to pincode ${v.pincode} yet.`
    : v.cod
      ? `Yes, cash on delivery is available for ${v.place} (orders between ₹299 and ₹4,999, ₹49 COD fee). Delivery takes ${v.days} days. Paying online saves you 5%.`
      : `Cash on delivery isn't available for ${v.place}, but we do deliver there (${v.days} days). You can pay online — and prepaid orders get 5% off.`,
  policy: (v) => v.text,
  injection: () => "I can't do that. I can only help with your Wishluck orders under our store policy — refunds are decided by the policy, not by chat requests. Is there something about your order I can help with?",
  data_leak: () => "Sorry, I can't share details of any other customer's orders or look up orders by someone else's number. If it's your order, please share the order ID and the phone number used on it.",
  handover: () => "I'm connecting you to our support team — someone from the team will join this chat shortly. I've shared the details so you won't need to repeat yourself.",
  handover_paused: () => 'Our support team has your conversation and will reply here shortly.',
  clarify: () => "Sorry, I didn't quite get that. I can help with order status, cancellation, returns/exchanges, address change, refunds, sizes and policies. What would you like to do?",
  thanks: () => "You're welcome! Anything else I can help with?",
  action_cancelled: () => "Okay, I haven't made any changes. Anything else I can help with?",
  bulk: () => 'For bulk or corporate orders our team will help you directly.',
  goodwill: () => 'I understand. Compensation requests are reviewed by our team, so I am passing this on to them.',
  // COD
  cod_confirm: (v) => `Hi ${v.name}! Thanks for your order ${v.orderId} on Wishluck.\n\nItems: ${items(v.order)}\nAmount to pay on delivery: ${inr(v.order.total)}\nDeliver to: ${v.address}\n\nPlease confirm your Cash on Delivery order. Tip: pay online now and get 5% off (pay ${inr(v.prepaid)} instead).`,
  cod_reminder: (v) => `Reminder: your COD order ${v.orderId} (${inr(v.total)}) is waiting for confirmation. We'll ship it as soon as you confirm.`,
  cod_confirmed: (v) => `Thank you! Order ${v.orderId} is confirmed and will be shipped soon. Please keep ${inr(v.total)} ready at delivery.`,
  cod_cancel_q: (v) => `Just to confirm: cancel order ${v.orderId} (${inr(v.total)})? Nothing has been charged.`,
  cod_cancelled: (v) => `Order ${v.orderId} has been cancelled. Hope to see you again!`,
  cod_prepaid: (v) => `Great choice! Pay ${inr(v.payable)} online (5% off, no COD fee) using this secure link: ${v.link}\nYour order ships as soon as the payment is done.`,
  cod_prepaid_done: (v) => `Payment of ${inr(v.paid)} received for order ${v.orderId}. Your order is confirmed and will ship soon.`,
  cod_hold: (v) => `We haven't heard back, so order ${v.orderId} is on hold. Reply here any time to confirm it.`,
  cod_address_ask: () => 'Sure — please send the complete new address with house/flat number, street, landmark and the 6-digit pincode.',
  cod_not_pending: (v) => `Order ${v.orderId} is already ${statusLabel('en', v.status)}.`,
  // NDR
  ndr: (v) => `Hi ${v.name}, the courier tried to deliver your order ${v.orderId} but couldn't: "${v.reason}". How would you like us to proceed?`,
  ndr_dates: () => 'Please pick a date for the next delivery attempt:',
  ndr_rescheduled: (v) => `Done — the courier will re-attempt delivery of order ${v.orderId} on ${fmtDate(v.date)}.`,
  ndr_bad_date: () => 'We can re-attempt delivery within the next 3 days. Please pick one of these dates:',
  ndr_address_done: (v) => `Thanks — the courier has the updated address/landmark for order ${v.orderId} and will re-attempt delivery.`,
  ndr_phone_ask: () => 'Please share the alternate 10-digit mobile number the courier can call.',
  ndr_phone_done: (v) => `Thanks — the courier will call ${v.phone} before the next attempt for order ${v.orderId}.`,
  ndr_phone_bad: () => "That doesn't look like a valid 10-digit Indian mobile number. Please send it again.",
  ndr_rto_reason: () => "Sorry to hear that. Could you tell us why you don't want the order anymore? It helps us improve.",
  ndr_rto_q: (v) => `Just to confirm: we'll stop delivery and return order ${v.orderId} to us${v.prepaid ? ` (refund of ${inr(v.refund)} after it reaches us — order total minus ₹99 shipping)` : ''}. Shall I go ahead?`,
  ndr_rto_done: (v) => `Okay, order ${v.orderId} will be returned to us. ${v.prepaid ? 'Your refund will be processed once it reaches our warehouse.' : ''}`,
  ndr_reminder: (v) => `Reminder: delivery of order ${v.orderId} failed ("${v.reason}"). Please tell us when to re-attempt so your order isn't returned.`,
  yes: () => 'Yes, go ahead', no: () => 'No',
  b_confirm: () => 'Confirm order', b_cancel: () => 'Cancel order', b_edit: () => 'Edit address', b_prepaid: () => 'Pay online & save 5%',
  b_resched: () => 'Reschedule delivery', b_addr: () => 'Update address / landmark', b_phone: () => 'Share another number', b_rto: () => "I don't want it",
  b_bank: () => 'Bank transfer', b_credit: () => 'Store credit', b_callback: () => 'Request callback',
};

const hinglish: Dict = {
  ...en,
  greeting: () => 'Namaste! Main Wishluck support assistant hoon. Order tracking, cancel, return/exchange, refund, size aur policy — sab mein help kar sakta hoon. Bataiye kya madad karun?',
  ask_verify: () => 'Zaroor! Aapki details safe rakhne ke liye, apna order ID (WL se shuru hota hai, jaise WL1XXXX) aur order par diya gaya phone number bhejiye.',
  ask_phone: (v) => `Thanks. Order ${v.orderId} par jo phone number diya tha, woh bhi bhejiye taaki verify kar sakun.`,
  ask_order_id: () => 'Thanks. Apna order ID bhi bhejiye (WL se shuru hota hai, jaise WL1XXXX).',
  verify_failed: () => 'Sorry, yeh order ID aur phone number hamare record se match nahi kar rahe, isliye main order details share nahi kar sakta. Dono dobara check karke bhejiye.',
  verify_locked: () => 'Kai baar try karne ke baad bhi verify nahi ho paya. Aapki safety ke liye main aapko hamari support team se connect kar raha hoon.',
  order_status: (v) => {
    const o = v.order; const t = v.tracking;
    let s = `Aapka order ${o.id} (${items(o)}) ${statusLabel('hinglish', t?.current_status ?? o.status)}.`;
    if (t?.last_update?.location) s += ` Last update: ${t.last_update.location}${t.last_update.at ? `, ${fmtDate(t.last_update.at)}` : ''}.`;
    if (t?.scheduled_date) s += ` Agli delivery attempt ${fmtDate(t.scheduled_date)} ko hai.`;
    if (o.status !== 'delivered' && o.status !== 'cancelled' && o.eta_from) s += ` Expected delivery: ${fmtDate(o.eta_from)} – ${fmtDate(o.eta_to)} tak.`;
    if (o.status === 'delivered' && o.delivered_on) s += ` ${fmtDate(o.delivered_on)} ko deliver hua.`;
    if (t?.tracking_url) s += `\nTracking link: ${t.tracking_url}`;
    return s;
  },
  tool_down: () => 'Abhi live details fetch nahi ho pa rahi — hamara system respond nahi kar raha. Kya aap team se callback chahenge? "callback" likh dijiye.',
  callback_created: () => 'Ho gaya — callback request kar di hai. Hamari team aapke registered number par call karegi.',
  cancel_q: (v) => `Confirm kar dijiye: main order ${v.order.id} (${items(v.order)}, ${inr(v.order.total)}) cancel karne ja raha hoon. ${v.refundNote ?? ''} Kar doon?`,
  cancel_done: (v) => `Order ${v.orderId} cancel ho gaya hai. ${v.refundNote ?? ''}`,
  cancel_shipped: (v) => `Order ${v.orderId} ship ho chuka hai, isliye ab cancel nahi ho sakta. ${v.note}`,
  return_rejected: (v) => `Sorry, ${v.item} return nahi ho sakta: ${v.reason}${v.exchange ? ' Lekin size exchange ho sakta hai — kaunsa size chahiye?' : ''}`,
  return_q: (v) => `Confirm kar dijiye: order ${v.orderId} se ${v.item} ka return raise kar raha hoon. Refund: ${inr(v.amount)} ${v.methodText}. Item unused aur tags ke saath hona chahiye. Kar doon?`,
  return_done: (v) => `Aapki return request ${v.returnId} ban gayi hai. ${v.timeline}`,
  return_review_q: (v) => `Yeh return (${v.item}, ${inr(v.amount)}) policy ke hisaab se hamari team manually review karegi. Review ke liye raise kar doon?`,
  ask_refund_method: () => 'Yeh COD order tha — refund kaise chahiye: bank transfer ya store credit?',
  exchange_q: (v) => `Confirm kar dijiye: order ${v.orderId} ka ${v.item} size ${v.from} se size ${v.to} mein exchange kar raha hoon (${v.to} stock mein hai). Item unused aur tags ke saath rakhiye. Kar doon?`,
  exchange_done: (v) => `Ho gaya! Exchange ${v.returnId} ban gaya hai — hum ${v.from} pick karenge aur size ${v.to} bhejenge.`,
  exchange_rejected: (v) => `Sorry, yeh exchange nahi ho sakta: ${v.reason}`,
  ask_size: (v) => `Kaunsa size chahiye? ${v.item} in sizes mein aata hai: ${v.sizes}.`,
  ask_item: (v) => `Kis item ke baare mein baat kar rahe hain? Aapke order mein hai: ${v.items}.`,
  address_ask: () => 'Naya poora address bhejiye — house/flat number, street, area, landmark aur 6-digit pincode ke saath.',
  address_q: (v) => `Confirm kar dijiye: order ${v.orderId} ka delivery address "${v.address}" (pincode ${v.pincode}) kar doon?`,
  address_done: (v) => `Ho gaya — order ${v.orderId} ka address update ho gaya hai.`,
  address_rejected: (v) => `Address change nahi ho sakta: ${v.reason}`,
  address_unclear: () => 'Is address mein 6-digit pincode nahi mila. Pincode ke saath poora address bhejiye.',
  size_advice: (v) => v.recommended
    ? `${v.product} ke liye size chart ke hisaab se ${v.recommended} size sahi rahega${v.alternatives?.length ? ` (thoda loose chahiye toh ${v.alternatives.join('/')})` : ''}.${v.note ? ' ' + v.note : ''}`
    : `Apni height aur weight bataiye (jaise 5'8", 70 kg), main ${v.product} ka size chart check karta hoon.`,
  pincode_cod: (v) => !v.serviceable
    ? `Sorry, pincode ${v.pincode} par abhi delivery nahi hoti.`
    : v.cod
      ? `Haan, ${v.place} mein Cash on Delivery milega (₹299 se ₹4,999 tak ke orders, ₹49 COD fee). Delivery ${v.days} din mein. Online pay karne par 5% off milta hai.`
      : `${v.place} mein COD available nahi hai, lekin delivery hoti hai (${v.days} din). Aap online pay kar sakte hain — prepaid par 5% off bhi milega.`,
  injection: () => 'Yeh main nahi kar sakta. Main sirf store policy ke hisaab se aapke Wishluck orders mein help kar sakta hoon — refund policy se decide hota hai, chat request se nahi. Order se related kuch help chahiye?',
  data_leak: () => 'Sorry, main kisi aur customer ke order details share nahi kar sakta. Agar order aapka hai toh order ID aur us order ka phone number bhejiye.',
  handover: () => 'Main aapko hamari support team se connect kar raha hoon — team ka koi member thodi der mein isi chat mein join karega. Saari details share kar di hain, dobara batane ki zaroorat nahi.',
  handover_paused: () => 'Hamari support team aapki chat dekh rahi hai aur jaldi reply karegi.',
  clarify: () => 'Sorry, samajh nahi aaya. Main order status, cancel, return/exchange, address change, refund, size aur policy mein help kar sakta hoon. Kya karna hai?',
  thanks: () => 'Aapka swagat hai! Aur kuch help chahiye?',
  action_cancelled: () => 'Theek hai, maine koi change nahi kiya. Aur kuch?',
  bulk: () => 'Bulk ya corporate orders ke liye hamari team aapse directly baat karegi.',
  goodwill: () => 'Main samajh sakta hoon. Compensation requests hamari team review karti hai, main unhe pass kar raha hoon.',
  cod_confirm: (v) => `Hi ${v.name}! Wishluck par order ${v.orderId} ke liye thanks.\n\nItems: ${items(v.order)}\nDelivery par pay karna hai: ${inr(v.order.total)}\nAddress: ${v.address}\n\nPlease apna COD order confirm kijiye. Abhi online pay karein toh 5% off (sirf ${inr(v.prepaid)}).`,
  cod_reminder: (v) => `Reminder: aapka COD order ${v.orderId} (${inr(v.total)}) confirmation ka wait kar raha hai. Confirm karte hi ship kar denge.`,
  cod_confirmed: (v) => `Thank you! Order ${v.orderId} confirm ho gaya, jaldi ship hoga. Delivery par ${inr(v.total)} ready rakhiye.`,
  cod_cancel_q: (v) => `Confirm kijiye: order ${v.orderId} (${inr(v.total)}) cancel kar doon? Koi charge nahi laga hai.`,
  cod_cancelled: (v) => `Order ${v.orderId} cancel ho gaya hai.`,
  cod_prepaid: (v) => `Badhiya! Is secure link se ${inr(v.payable)} online pay kijiye (5% off, COD fee nahi): ${v.link}\nPayment hote hi order ship hoga.`,
  cod_prepaid_done: (v) => `Order ${v.orderId} ke liye ${inr(v.paid)} ka payment mil gaya. Order confirm hai, jaldi ship hoga.`,
  cod_hold: (v) => `Aapka reply nahi aaya, isliye order ${v.orderId} hold par hai. Kabhi bhi yahan reply karke confirm kar sakte hain.`,
  cod_address_ask: () => 'Zaroor — naya poora address bhejiye: house/flat number, street, landmark aur 6-digit pincode.',
  ndr: (v) => `Hi ${v.name}, courier ne aapka order ${v.orderId} deliver karne ki koshish ki lekin ho nahi paya: "${v.reason}". Aage kya karein?`,
  ndr_dates: () => 'Agli delivery attempt ke liye date chuniye:',
  ndr_rescheduled: (v) => `Ho gaya — courier ${fmtDate(v.date)} ko order ${v.orderId} dobara deliver karega.`,
  ndr_bad_date: () => 'Agle 3 din mein hi dobara attempt ho sakta hai. Inme se ek date chuniye:',
  ndr_address_done: (v) => `Thanks — courier ke paas order ${v.orderId} ka updated address/landmark hai, dobara attempt hoga.`,
  ndr_phone_ask: () => 'Courier kis doosre 10-digit mobile number par call kare? Bhejiye.',
  ndr_phone_done: (v) => `Thanks — agli attempt se pehle courier ${v.phone} par call karega.`,
  ndr_phone_bad: () => 'Yeh valid 10-digit mobile number nahi lag raha. Dobara bhejiye.',
  ndr_rto_reason: () => 'Achha. Order kyun nahi chahiye, bata sakte hain? Isse humein improve karne mein madad milegi.',
  ndr_rto_q: (v) => `Confirm kijiye: delivery rok kar order ${v.orderId} wapas mangwa lein${v.prepaid ? ` (wapas aane par ${inr(v.refund)} refund — total minus ₹99 shipping)` : ''}?`,
  ndr_rto_done: (v) => `Theek hai, order ${v.orderId} wapas aa jayega. ${v.prepaid ? 'Warehouse pahunchne par refund process hoga.' : ''}`,
  ndr_reminder: (v) => `Reminder: order ${v.orderId} ki delivery fail hui ("${v.reason}"). Batayein kab dobara bhejein, warna order wapas chala jayega.`,
  yes: () => 'Haan, kar do', no: () => 'Nahi',
  b_confirm: () => 'Order confirm', b_cancel: () => 'Order cancel', b_edit: () => 'Address badlein', b_prepaid: () => 'Online pay, 5% bachayein',
  b_resched: () => 'Dobara delivery', b_addr: () => 'Address / landmark update', b_phone: () => 'Doosra number', b_rto: () => 'Order nahi chahiye',
  b_bank: () => 'Bank transfer', b_credit: () => 'Store credit', b_callback: () => 'Callback chahiye',
};

const hi: Dict = {
  ...hinglish,
  greeting: () => 'नमस्ते! मैं Wishluck सपोर्ट असिस्टेंट हूँ। ऑर्डर ट्रैकिंग, कैंसल, रिटर्न/एक्सचेंज, रिफंड, साइज़ और पॉलिसी में मदद कर सकता हूँ। बताइए क्या मदद करूँ?',
  ask_verify: () => 'ज़रूर! आपकी जानकारी सुरक्षित रखने के लिए अपना ऑर्डर ID (जैसे WL1XXXX) और ऑर्डर पर दिया गया फ़ोन नंबर भेजिए।',
  ask_phone: (v) => `धन्यवाद। ऑर्डर ${v.orderId} पर दिया गया फ़ोन नंबर भी भेजिए।`,
  ask_order_id: () => 'धन्यवाद। अपना ऑर्डर ID भी भेजिए (जैसे WL1XXXX)।',
  verify_failed: () => 'माफ़ कीजिए, यह ऑर्डर ID और फ़ोन नंबर हमारे रिकॉर्ड से मेल नहीं खाते, इसलिए मैं कोई जानकारी साझा नहीं कर सकता। कृपया दोनों दोबारा जाँचकर भेजिए।',
  order_status: (v) => {
    const o = v.order; const t = v.tracking;
    let s = `आपका ऑर्डर ${o.id} (${items(o)}) ${statusLabel('hi', t?.current_status ?? o.status)}।`;
    if (t?.last_update?.location) s += ` आख़िरी अपडेट: ${t.last_update.location}।`;
    if (o.status !== 'delivered' && o.status !== 'cancelled' && o.eta_from) s += ` अनुमानित डिलीवरी: ${fmtDate(o.eta_from)} – ${fmtDate(o.eta_to)}।`;
    if (t?.tracking_url) s += `\nट्रैकिंग लिंक: ${t.tracking_url}`;
    return s;
  },
  injection: () => 'मैं ऐसा नहीं कर सकता। मैं सिर्फ़ स्टोर पॉलिसी के अनुसार आपके Wishluck ऑर्डर में मदद कर सकता हूँ।',
  data_leak: () => 'माफ़ कीजिए, मैं किसी दूसरे ग्राहक के ऑर्डर की जानकारी साझा नहीं कर सकता।',
  handover: () => 'मैं आपको हमारी सपोर्ट टीम से जोड़ रहा हूँ — टीम का कोई सदस्य जल्द ही इसी चैट में जुड़ेगा।',
  clarify: () => 'माफ़ कीजिए, समझ नहीं आया। मैं ऑर्डर स्टेटस, कैंसल, रिटर्न/एक्सचेंज, पता बदलना, रिफंड, साइज़ और पॉलिसी में मदद कर सकता हूँ।',
  thanks: () => 'आपका स्वागत है! और कुछ मदद चाहिए?',
  action_cancelled: () => 'ठीक है, मैंने कोई बदलाव नहीं किया।',
  yes: () => 'हाँ, कर दो', no: () => 'नहीं',
};

const DICTS: Record<Lang, Dict> = { en, hinglish, hi };
export function t(lang: Lang, key: string, v: any = {}): string {
  const f = DICTS[lang]?.[key] ?? en[key];
  if (!f) return key;
  return f(v).replace(/\s+\n/g, '\n').replace(/ {2,}/g, ' ').trim();
}

export const yesNo = (lang: Lang, ns = 'confirm'): Button[] => [{ id: `${ns}:yes`, label: t(lang, 'yes') }, { id: `${ns}:no`, label: t(lang, 'no') }];
