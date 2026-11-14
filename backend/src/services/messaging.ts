import { addMessage, getConversation, type Message } from './conversations.js';
import { sendWhatsApp } from '../channels/whatsapp.js';
import type { Reply } from '../agent/templates.js';

/**
 * Sends a message to the customer on the conversation's channel. Web chat reads it from the DB/SSE;
 * WhatsApp gets an API call. `dedupeKey` makes proactive messages (COD confirmation, NDR) idempotent.
 */
export async function sendToCustomer(conversationId: string, reply: Reply, opts: { role?: 'agent' | 'human' | 'system'; dedupeKey?: string; meta?: any } = {}): Promise<Message | null> {
  const msg = addMessage(conversationId, opts.role ?? 'agent', reply.text, { ...(opts.meta ?? {}), buttons: reply.buttons ?? [] }, opts.dedupeKey);
  if (!msg) return null;
  const conv = getConversation(conversationId);
  if (conv?.channel === 'whatsapp' && conv.customer_phone) await sendWhatsApp(conv.customer_phone, reply.text, reply.buttons);
  return msg;
}
