import type { JobHandler } from './index.js';
import { codHold, codReminder, createShipmentFor, sendCodConfirmation } from '../services/cod.js';
import { ndrContact, ndrEscalate, ndrReminder } from '../services/ndr.js';
import { handleCourierEvent, markWebhook, processOrderWebhook } from '../services/webhooks.js';

/** Every background job the system runs. All handlers are idempotent (safe to retry). */
export const jobHandlers: Record<string, JobHandler> = {
  'webhook.order': async ({ eventId, payload, source }) => { await processOrderWebhook(payload, source); markWebhook(source === 'shopify' ? 'shopify' : 'orders', eventId, 'processed'); },
  'webhook.courier': async ({ eventId, payload }) => { await handleCourierEvent(payload); markWebhook('courier', eventId, 'processed'); },
  'cod.send_confirmation': ({ orderId }) => sendCodConfirmation(orderId),
  'cod.reminder': ({ orderId }) => codReminder(orderId),
  'cod.hold': ({ orderId }) => codHold(orderId),
  'ndr.contact': ({ orderId, attempt }) => ndrContact(orderId, attempt),
  'ndr.reminder': ({ orderId, attempt }) => ndrReminder(orderId, attempt),
  'ndr.escalate': ({ orderId, attempt }) => ndrEscalate(orderId, attempt),
  'shipment.create': ({ orderId }) => createShipmentFor(orderId),
};
