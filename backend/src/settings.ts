import { z } from 'zod';
import { getDb } from './db/index.js';

/**
 * Everything ops may want to tune without a deploy. Stored as one JSON row in `settings`
 * and editable from the dashboard Settings screen.
 */
export const SettingsSchema = z.object({
  timings: z.object({
    /** delay before the COD confirmation message is sent (must be < 60s per spec) */
    codConfirmDelaySec: z.number().min(0).max(60),
    codReminderSec: z.number().min(1),
    codHoldSec: z.number().min(1),
    /** if the customer has not answered an NDR message after this long → one reminder */
    ndrReminderSec: z.number().min(1),
    /** if still no answer after this long and ≥2 attempts failed → hand over */
    ndrEscalateSec: z.number().min(1),
  }),
  risk: z.object({
    mediumThreshold: z.number().min(0).max(100),
    highThreshold: z.number().min(0).max(100),
    /** skip the confirmation message for COD orders scoring below this (0 = always confirm) */
    autoConfirmBelow: z.number().min(0).max(100),
    weights: z.object({
      highValue: z.number(), veryHighValue: z.number(), weakAddress: z.number(), noHouseNumber: z.number(),
      pincodeRto: z.number(), newCustomer: z.number(), repeatCustomerCredit: z.number(),
      pastRefusal: z.number(), codVelocity: z.number(), suspiciousContact: z.number(), lateNight: z.number(),
      remoteZone: z.number(),
    }),
  }),
  handover: z.object({
    refundLimit: z.number().min(0),
    maxUnresolvedTurns: z.number().min(1),
    maxToolFailures: z.number().min(1),
    maxVerifyAttempts: z.number().min(1),
    handoverOnInjectionRepeat: z.boolean(),
    legalKeywords: z.array(z.string()),
    angerKeywords: z.array(z.string()),
    humanKeywords: z.array(z.string()),
  }),
  agent: z.object({
    llmEnabled: z.boolean(),
    groundingCheck: z.boolean(),
  }),
  simulation: z.object({
    courierOutage: z.boolean(),
  }),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  timings: { codConfirmDelaySec: 5, codReminderSec: 2 * 3600, codHoldSec: 24 * 3600, ndrReminderSec: 3600, ndrEscalateSec: 6 * 3600 },
  risk: {
    mediumThreshold: 35,
    highThreshold: 60,
    autoConfirmBelow: 0,
    weights: {
      highValue: 10, veryHighValue: 20, weakAddress: 15, noHouseNumber: 10, pincodeRto: 20,
      newCustomer: 15, repeatCustomerCredit: -15, pastRefusal: 25, codVelocity: 15, suspiciousContact: 10,
      lateNight: 5, remoteZone: 5,
    },
  },
  handover: {
    refundLimit: 1500,
    maxUnresolvedTurns: 2,
    maxToolFailures: 2,
    maxVerifyAttempts: 3,
    handoverOnInjectionRepeat: true,
    legalKeywords: ['consumer court', 'consumer forum', 'consumer helpline', 'legal action', 'lawyer', 'advocate', 'legal notice', 'police', 'sue', 'court', 'complaint to', 'post on twitter', 'tweet about', 'post on instagram', 'post on linkedin', 'social media', 'post about', 'go viral', 'expose you', 'review bomb', 'chargeback'],
    angerKeywords: ['third time', '3rd time', 'worst', 'pathetic', 'fraud', 'scam', 'cheat', 'useless', 'disgusting', 'bakwas', 'bekar', 'ghatiya', 'chor', 'dhokha', 'fed up', 'ridiculous', 'never again', 'unacceptable'],
    humanKeywords: ['human', 'real person', 'agent please', 'talk to agent', 'customer care', 'manager', 'supervisor', 'insaan', 'kisi se baat', 'representative', 'executive'],
  },
  agent: { llmEnabled: true, groundingCheck: true },
  simulation: { courierOutage: false },
};

/** Timings suitable for demos/tests: seconds instead of hours. */
export const FAST_TIMINGS: Settings['timings'] = {
  codConfirmDelaySec: 2, codReminderSec: 30, codHoldSec: 90, ndrReminderSec: 30, ndrEscalateSec: 60,
};

let cache: Settings | null = null;

function deepMerge(base: any, over: any): any {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over ?? base;
  const out: any = { ...base };
  for (const k of Object.keys(over || {})) out[k] = k in base ? deepMerge(base[k], over[k]) : over[k];
  return out;
}

export function getSettings(): Settings {
  if (cache) return cache;
  const row = getDb().prepare(`SELECT value FROM settings WHERE key='app'`).get() as { value: string } | undefined;
  const stored = row ? JSON.parse(row.value) : {};
  cache = SettingsSchema.parse(deepMerge(DEFAULT_SETTINGS, stored));
  return cache;
}

export function updateSettings(patch: unknown): Settings {
  const merged = SettingsSchema.parse(deepMerge(getSettings(), patch));
  if (merged.risk.mediumThreshold >= merged.risk.highThreshold) {
    throw new Error('mediumThreshold must be lower than highThreshold');
  }
  getDb().prepare(`INSERT INTO settings(key,value) VALUES('app',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(merged));
  cache = merged;
  return merged;
}

export function resetSettingsCache() { cache = null; }
