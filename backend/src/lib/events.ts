import { EventEmitter } from 'node:events';

/** In-process pub/sub that feeds the SSE streams (inbox + chat widget). */
export const bus = new EventEmitter();
bus.setMaxListeners(1000);

export type BusEvent =
  | { type: 'conversation.updated'; conversationId: string }
  | { type: 'message.created'; conversationId: string; message: any }
  | { type: 'order.updated'; orderId: string }
  | { type: 'ticket.created'; ticketId: string; conversationId?: string | null };

export const publish = (e: BusEvent) => bus.emit('event', e);
