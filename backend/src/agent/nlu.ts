/**
 * Deterministic language understanding used by:
 *  - the safety guards that run BEFORE any model call (injection, data-leak, handover triggers),
 *  - code-level verification (order id + phone extraction),
 *  - the rule-based fallback agent when no LLM is configured or the LLM is down,
 *  - analytics ("most common requests").
 */
import type { Settings } from '../settings.js';
import { parseHeightCm, parseWeightKg } from '../policy/policyDoc.js';
import { istDate } from '../lib/time.js';

export type Lang = 'en' | 'hinglish' | 'hi';

const HINGLISH = new Set(('mera meri mere mujhe mujhko humko hamara kab kya kyu kyun kyon hai hain hoga hogi nahi nahin nai chahiye chahie bhai bhaiya yaar kar karo kardo karna krna karke de do dedo milega milegi mil jayega jayega jaega aayega ayega aaega aaya aya gaya gya tha thi raha rahi rha wala wali abhi kitne kitna paisa paise wapas wapis badalna badal badlo dikkat theek thik haan haa ji accha acha bata batao btao lekin kaise kahan kidhar toh bhi hua hui kal parso aaj subah shaam ghar daftar chhota chota bada tight dhila lena lelo bhejo bhej sakte sakta sakti kijiye kariye karein apna apni aapka aapki tum aap hum koi kuch sab sirf bas jaldi pata kaun kaunsa wala liye mein mai').split(' '));

export function detectLanguage(text: string, prev: Lang = 'en'): Lang {
  if (/[ऀ-ॿ]/.test(text)) return 'hi';
  const words = text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return prev;
  const hits = words.filter((w) => HINGLISH.has(w)).length;
  if (hits >= 2 || (hits >= 1 && words.length <= 3)) return 'hinglish';
  // Very short replies ("yes", "ok", "L") keep the previous language
  if (words.length <= 2) return prev;
  return 'en';
}

export interface Entities {
  orderIds: string[]; phones: string[]; maskedPhones: string[]; pincodes: string[]; sizes: string[];
  date?: string; heightCm?: number; weightKg?: number; product?: string; amounts: number[];
}

const PRODUCT_WORDS: [RegExp, string][] = [
  [/\bsale\s*(tee|t-?shirt)\b/i, 'WL-SAL-06'],
  [/\b(brief|briefs|underwear|innerwear|chaddi|kachha|undies)\b/i, 'WL-BRF-04'],
  [/\b(kurta|kurtas|kurti)\b/i, 'WL-KUR-01'],
  [/\b(jeans|denim|pant|pants)\b/i, 'WL-JNS-03'],
  [/\b(tote|bag|jhola)\b/i, 'WL-BAG-05'],
  [/\b(tee|t-?shirt|tshirt|graphic)\b/i, 'WL-TEE-02'],
];

export function extractEntities(text: string): Entities {
  const orderIds = [...text.matchAll(/(?:\bWL[-\s]?|#\s?)(\d{5})\b/gi)].map((m) => `WL${m[1]}`);
  const phoneMatches = [...text.matchAll(/(?<![\dA-Za-z])(?:\+?91[-\s]?)?([6-9]\d{4}[-\s]?\d{5})(?!\d)/g)];
  const phones = phoneMatches.map((m) => m[1].replace(/\D/g, ''));
  const maskedPhones = [...text.matchAll(/\b\d{2,5}[xX*•]{3,8}\d{2,4}\b/g)].map((m) => m[0]);
  const noPhones = text.replace(/(?:\+?91[-\s]?)?[6-9]\d{4}[-\s]?\d{5}/g, ' ');
  const pincodes = [...noPhones.matchAll(/(?<![\dA-Za-z])([1-9]\d{5})(?!\d)/g)].map((m) => m[1]);
  const sizes: string[] = [];
  const sizeRe = /(?:\bsize\s*(?:is|of|=|:)?\s*|\b)(xxl|2xl|xl|l|m|s|small|medium|large|extra large)(?:\s*size)?\b/gi;
  for (const m of text.matchAll(sizeRe)) {
    const raw = m[1];
    const full = m[0].toLowerCase();
    // Single letters only count when written in capitals or next to the word "size" (avoid "I'm", "is", ...)
    if (raw.length === 1 && raw !== raw.toUpperCase() && !full.includes('size')) continue;
    const map: Record<string, string> = { small: 'S', medium: 'M', large: 'L', 'extra large': 'XL', '2xl': 'XXL' };
    sizes.push(map[raw.toLowerCase()] ?? raw.toUpperCase());
  }
  for (const m of text.matchAll(/\b(?:size|waist)\s*(28|30|32|34|36)\b|\b(28|30|32|34|36)\s*(?:size|waist|inch)/gi)) sizes.push(m[1] ?? m[2]);
  let product: string | undefined;
  for (const [re, sku] of PRODUCT_WORDS) if (re.test(text)) { product = sku; break; }
  const amounts = [...text.matchAll(/(?:₹|rs\.?|inr)\s?(\d[\d,]*)|(\d[\d,]{2,})\s*(?:rs|rupees|rupaye|₹)/gi)].map((m) => Number((m[1] ?? m[2]).replace(/,/g, '')));
  return { orderIds: [...new Set(orderIds)], phones: [...new Set(phones)], maskedPhones, pincodes: [...new Set(pincodes)], sizes: [...new Set(sizes)], date: extractDate(text), heightCm: parseHeightCm(text), weightKg: parseWeightKg(text), product, amounts };
}

const DOW = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** Returns YYYY-MM-DD for delivery-date phrases ("kal", "tomorrow", "day after", "friday", "18 nov", "2026-11-18"). */
export function extractDate(text: string, now = Date.now()): string | undefined {
  const t = text.toLowerCase();
  const plus = (n: number) => istDate(now + n * 86_400_000);
  const iso = t.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  if (/\b(day after tomorrow|parso|parson|परसों)\b/.test(t)) return plus(2);
  if (/\b(tomorrow|tmrw|kal|कल)\b/.test(t)) return plus(1);
  if (/\b(today|aaj|आज)\b/.test(t)) return plus(0);
  const dm = t.match(/\b(\d{1,2})\s*(?:st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/) || t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*(\d{1,2})\b/);
  if (dm) {
    const day = Number(/\d/.test(dm[1]) ? dm[1] : dm[2]);
    const mon = MON.indexOf((/\d/.test(dm[1]) ? dm[2] : dm[1]).slice(0, 3));
    const y = new Date(now).getUTCFullYear();
    let d = new Date(Date.UTC(y, mon, day));
    if (d.getTime() < now - 2 * 86_400_000) d = new Date(Date.UTC(y + 1, mon, day));
    return d.toISOString().slice(0, 10);
  }
  for (let i = 0; i < 7; i++) {
    if (new RegExp(`\\b${DOW[i]}\\b`).test(t)) {
      const today = new Date(now + 5.5 * 3600_000).getUTCDay();
      const diff = ((i - today + 7) % 7) || 7;
      return plus(diff);
    }
  }
  return undefined;
}

const AFFIRM = /^(yes|y|yeah|yea|yep|yup|sure|ok|okay|okk|k|confirm|confirmed|go ahead|do it|please do|proceed|correct|right|haan|han|haa|ha|hn|ji|jee|ji haan|haan ji|theek hai|thik hai|thik h|theek h|kar do|kardo|karo|done|sahi|sahi hai|bilkul|zaroor|haan kar do|हाँ|हां|जी|ठीक है|कर दो)\b/i;
const NEGATE = /^(no|nope|nah|n|don'?t|do not|cancel that|stop|not now|leave it|nahi|nahin|nai|na|mat|mat karo|rehne do|rhne do|रहने दो|नहीं|ना)\b/i;
const clean = (t: string) => t.trim().toLowerCase().replace(/[.!?,🙏👍]+/g, ' ').replace(/\s+/g, ' ').trim();
export const isAffirmative = (t: string) => { const c = clean(t); return c.split(' ').length <= 7 && AFFIRM.test(c) && !NEGATE.test(c); };
export const isNegative = (t: string) => { const c = clean(t); return c.split(' ').length <= 7 && NEGATE.test(c); };

// ---------------------------------------------------------------------------------------------
// Safety guards
// ---------------------------------------------------------------------------------------------
const INJECTION_PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget|override|bypass|skip)\b[^.]{0,40}\b(instruction|instructions|rules?|polic(y|ies)|guidelines?|prompts?|restrictions?|system)\b/i,
  /\b(instructions?|rules?|niyam)\b[^.]{0,20}\b(ignore|bhool|bhul|chhod|hatao)\b/i,
  /\b(system prompt|your prompt|hidden prompt|initial prompt|developer (message|mode)|your instructions|internal instructions|configuration)\b/i,
  /\b(reveal|print|show|repeat|leak|tell me)\b[^.]{0,30}\b(prompt|instructions|rules you|system message|tools you)\b/i,
  /\b(you are now|from now on you|act as|pretend (to be|you are)|roleplay as|jailbreak|dan mode|admin mode|god mode|sudo)\b/i,
  /\b(i am|i'm|this is)\s+(the\s+)?(admin|administrator|developer|owner|ceo|founder|wishluck (staff|team|support))\b/i,
  /<\s*\/?\s*(system|assistant|tool)\s*>/i,
  /\b(new|updated) (instructions|policy) (from|by) (wishluck|management|admin)\b/i,
];
export function detectInjection(text: string): string | null {
  for (const re of INJECTION_PATTERNS) { const m = text.match(re); if (m) return m[0]; }
  return null;
}

const OTHERS_DATA = /\b(orders? of|details of|order details for|someone else|other customers?|another customer|all (the )?(orders|customers)|customer (list|data|database)|kiske|kisi aur|uske orders?|unke orders?|my friend'?s|my (wife|husband|brother|sister|mother|father)'?s order|list (all|every))\b/i;
/** Requests for someone else's data: a masked phone number, or "orders of <number>", or bulk/other-customer data. */
export function detectDataLeak(text: string, ents: Entities, verifiedPhone: string | null): string | null {
  if (ents.maskedPhones.length) return 'masked_phone_lookup';
  if (OTHERS_DATA.test(text)) {
    if (ents.phones.length && verifiedPhone && ents.phones.every((p) => p === verifiedPhone)) return null;
    return 'other_customer_data';
  }
  if (ents.phones.length && !ents.orderIds.length && /\b(show|list|give|send|tell|find|search|lookup|look up)\b[^.]{0,25}\b(orders?|details|address|data)\b/i.test(text)) {
    if (verifiedPhone && ents.phones.every((p) => p === verifiedPhone)) return null;
    return 'phone_lookup';
  }
  return null;
}

const kw = (list: string[]) => list.filter(Boolean).map((k) => k.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const hasAny = (text: string, list: string[]) => { const l = kw(list); if (!l.length) return null; const m = text.toLowerCase().match(new RegExp(`(?:^|[^a-z])(${l.join('|')})(?:[^a-z]|$)`, 'i')); return m ? m[1] : null; };

export interface HandoverTrigger { code: 'customer_request' | 'legal_threat' | 'angry_customer'; reason: string }
export function detectHandoverTrigger(text: string, cfg: Settings['handover']): HandoverTrigger | null {
  const legal = hasAny(text, cfg.legalKeywords) || (/\bFIR\b/.test(text) ? 'FIR' : null);
  if (legal) return { code: 'legal_threat', reason: `Customer mentioned "${legal}" (legal action / public complaint).` };
  const human = hasAny(text, cfg.humanKeywords) || (/\b(talk|speak|connect)\b[^.]{0,20}\b(person|human|someone|agent|team)\b/i.test(text) ? 'talk to a person' : null);
  if (human) return { code: 'customer_request', reason: `Customer asked for a person ("${human}").` };
  const angry = hasAny(text, cfg.angerKeywords);
  const shouting = text.replace(/[^A-Z]/g, '').length > 12 && text.replace(/[^A-Z]/g, '').length / Math.max(1, text.replace(/[^A-Za-z]/g, '').length) > 0.7;
  if (angry || (shouting && /!{2,}/.test(text))) return { code: 'angry_customer', reason: angry ? `Customer is upset ("${angry}").` : 'Customer is shouting (all caps, repeated !!).' };
  return null;
}

export type Mood = 'angry' | 'frustrated' | 'neutral' | 'positive';
export function detectMood(text: string, cfg?: Settings['handover']): Mood {
  const t = text.toLowerCase();
  if (cfg && (hasAny(t, cfg.legalKeywords) || hasAny(t, cfg.angerKeywords))) return 'angry';
  if (/!{2,}/.test(text) || /\b(still|again|already|waiting|kab tak|abhi tak|late|delay|no response|not received|nahi mila|nahi aaya|disappointed|annoyed|upset)\b/.test(t)) return 'frustrated';
  if (/\b(thanks|thank you|thx|great|awesome|shukriya|dhanyavad|perfect|love)\b|धन्यवाद/.test(t)) return 'positive';
  return 'neutral';
}

// ---------------------------------------------------------------------------------------------
// Intent classification (fallback agent + analytics)
// ---------------------------------------------------------------------------------------------
export type Intent =
  | 'order_status' | 'cancel_order' | 'return' | 'exchange' | 'address_change' | 'refund_status' | 'size_help'
  | 'policy_cod' | 'policy_shipping' | 'policy_return' | 'policy_other' | 'callback' | 'goodwill' | 'greeting' | 'thanks'
  | 'bulk_order' | 'provide_details' | 'unknown';

const INTENTS: [Intent, RegExp][] = [
  ['bulk_order', /\b(bulk|wholesale|corporate order|100 pieces|50 pieces|reseller|b2b)\b/i],
  ['goodwill', /\b(compensation|compensate|goodwill|voucher for (the )?(delay|trouble)|make up for|harjana)\b|(?:₹|rs\.?|inr)?\s?\d{2,5}\s?(?:rs|rupees)?\s?(off|discount|back)\b[^.]{0,30}\b(delay|late|trouble|inconvenience)\b/i],
  ['callback', /\b(call ?back|callback|call me|phone kar|call karo)\b/i],
  ['refund_status', /\b(refund|paisa wapas|paise wapas|money back|amount credited|refund kab)\b.*\b(status|kab|when|where|kahan|milega|aaya|received|credited|pending|still|hasn'?t|has not|not (yet )?(come|received|credited)|nahi aaya|nahi mila)\b|\b(kab|when|where)\b.*\brefund\b|\brefund status\b/i],
  ['cancel_order', /\b(cancel|cancellation|call off|radd|nahi chahiye order|order mat bhejo|don'?t want (the|this|my) order|no longer (need|needed|want)|don'?t need (it|the order|this order))\b/i],
  ['exchange', /\b(exchange|replace|badal|badalna|badlo|change (the )?size|size change|bigger size|smaller size|wrong size|galat size|(\w+ )?size (mil|chahiye|milega|available)|for (an? )?(xxl|xl|l|m|s|\d\d) size|in (xxl|xl|l|m|s) size)\b|\b(XXL|XL|L|M|S)\s+(size\s+)?chahiye\b/],
  ['return', /\b(return|wapas|wapis|send back|refund me|money back|don'?t like|not happy with|damaged|defective|torn|phata|kharab)\b/i],
  ['exchange', /\b(tight|loose|dhila|chhota|chota|bada|doesn'?t fit|does not fit|not fitting|fit nahi)\b/i],
  ['address_change', /\b(change|update|edit|badal|different|new)\b[^.]{0,30}\b(address|pata|location|pincode)\b|\b(deliver|bhej|send)\b[^.]{0,30}\b(office|another address|different address|dusre address|naye address)\b|\b(address|pata)\b[^.]{0,20}\b(change|badal|update|galat|wrong)\b|\b(change|update)\b[^.]{0,20}\b(phone|number|mobile)\b/i],
  ['policy_cod', /\b(cod|cash on delivery|cash on del)\b/i],
  ['size_help', /\b(which size|what size|size chart|size guide|kaunsa size|konsa size|kya size|size suggest|fit me|meri height|my height|\d\s*'\s*\d|\d+\s*kg)\b/i],
  ['order_status', /\b(where|kahan|kab|when|status|track|tracking|ETA|deliver|delivery|aayega|ayega|aaega|pahunch|reach|arrive|shipped|dispatch|any update|update on|news on|kya hua)\b/i],
  ['policy_shipping', /\b(shipping|delivery charge|delivery fee|how many days|kitne din|free delivery|ship to|deliver to)\b/i],
  ['policy_return', /\b(return policy|exchange policy|refund policy|returnable|can i return)\b/i],
  ['policy_other', /\b(policy|terms|warranty)\b/i],
  ['thanks', /^(thanks|thank you|thx|ty|shukriya|dhanyavad|ok thanks|great thanks|धन्यवाद)\b/i],
  ['greeting', /^(hi|hii+|hello|hey|namaste|namaskar|hola|good (morning|afternoon|evening)|नमस्ते)\W*$/i],
];

export function classifyIntent(text: string, ents?: Entities): Intent {
  const e = ents ?? extractEntities(text);
  const t = text.trim();
  // policy questions phrased with "can I return" etc. take precedence over action intents when no order is referenced
  if (/\b(can i|do you|kya aap|kya)\b[^.]{0,20}\b(return|exchange)\b[^.]{0,30}\b(policy|items?|sale|innerwear|days)\b/i.test(t) && !e.orderIds.length) return 'policy_return';
  if (/\b(return|exchange|refund)s?\b[^.]{0,15}\b(window|policy|period|rules?|days)\b|\b(how many days|kitne din)\b[^.]{0,30}\b(return|exchange)\b/i.test(t) && !e.orderIds.length) return 'policy_return';
  if (/\b(cod|cash on delivery)\b/i.test(t) && (e.pincodes.length || /\b(milega|available|deliver|in|mein|me)\b/i.test(t)) && !e.orderIds.length) return 'policy_cod';
  for (const [intent, re] of INTENTS) if (re.test(t)) return intent;
  if (e.orderIds.length || e.phones.length) return 'provide_details';
  if (e.heightCm || e.weightKg) return 'size_help';
  return 'unknown';
}

/** Known city names → a pincode in our table, so "COD milega Guwahati mein?" can be answered. */
export const CITY_PINCODES: Record<string, string> = {
  delhi: '110001', 'new delhi': '110001', mumbai: '400001', bombay: '400001', bengaluru: '560001', bangalore: '560001', chennai: '600001',
  kolkata: '700001', hyderabad: '500001', pune: '411001', lucknow: '226010', jaipur: '302001', gorakhpur: '273001', patna: '800001',
  indore: '452001', guwahati: '781001', imphal: '795001', srinagar: '190001', 'port blair': '744101',
};
export function extractCity(text: string): string | undefined {
  const t = text.toLowerCase();
  return Object.keys(CITY_PINCODES).sort((a, b) => b.length - a.length).find((c) => new RegExp(`\\b${c}\\b`).test(t));
}
