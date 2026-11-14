import { Router, raw } from 'express';
import { config } from '../config.js';
import { verifySignature } from '../lib/hmac.js';
import { log } from '../lib/logger.js';
import { enqueueCourierWebhook, enqueueOrderWebhook, eventIdFor, fromShopify, OrderPayload, recordWebhookEvent } from '../services/webhooks.js';
import { parseWhatsAppWebhook } from '../channels/whatsapp.js';
import { findOrCreateForPhone, updateConversation } from '../services/conversations.js';
import { handleCustomerMessage } from '../agent/engine.js';

export function webhookRouter() {
  const r = Router();
  // raw body is required to verify HMAC signatures byte-for-byte
  r.use(raw({ type: '*/*', limit: '1mb' }));

  r.post('/orders', async (req, res) => {
    const body: Buffer = req.body;
    const shopifySig = req.header('x-shopify-hmac-sha256');
    const isShopify = !!shopifySig;
    const ok = isShopify
      ? verifySignature(config.secrets.shopifyWebhook, body, shopifySig)
      : verifySignature(config.secrets.orderWebhook, body, req.header('x-wishluck-hmac-sha256'));
    if (!ok) { log.warn('order webhook: bad signature'); return res.status(401).json({ error: 'invalid signature' }); }
    let payload;
    try {
      const json = JSON.parse(body.toString('utf8'));
      payload = isShopify ? fromShopify(json) : OrderPayload.parse(json);
    } catch (e: any) {
      return res.status(422).json({ error: 'invalid payload', details: e.issues ?? e.message });
    }
    const source = isShopify ? 'shopify' : 'orders';
    const eventId = eventIdFor(req.header(isShopify ? 'x-shopify-webhook-id' : 'x-wishluck-webhook-id'), body);
    if (!recordWebhookEvent(source, eventId, 'orders/create')) return res.status(200).json({ ok: true, duplicate: true, orderId: payload.id });
    await enqueueOrderWebhook(eventId, payload, isShopify ? 'shopify' : 'webhook');
    res.status(202).json({ ok: true, queued: true, orderId: payload.id, eventId });
  });

  r.post('/courier', async (req, res) => {
    const body: Buffer = req.body;
    if (!verifySignature(config.secrets.courierWebhook, body, req.header('x-courier-signature'))) {
      log.warn('courier webhook: bad signature');
      return res.status(401).json({ error: 'invalid signature' });
    }
    let payload: any;
    try { payload = JSON.parse(body.toString('utf8')); } catch { return res.status(422).json({ error: 'invalid json' }); }
    if (!payload?.awb || !payload?.status) return res.status(422).json({ error: 'awb and status required' });
    const eventId = eventIdFor(payload.event_id ?? req.header('x-courier-event-id'), body);
    if (!recordWebhookEvent('courier', eventId, payload.status)) return res.status(200).json({ ok: true, duplicate: true });
    await enqueueCourierWebhook(eventId, payload);
    res.status(202).json({ ok: true, queued: true, eventId });
  });

  // ---- WhatsApp Cloud API (optional)
  r.get('/whatsapp', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === config.whatsapp.verifyToken) return res.status(200).send(String(req.query['hub.challenge']));
    res.sendStatus(403);
  });
  r.post('/whatsapp', async (req, res) => {
    const body: Buffer = req.body;
    if (config.whatsapp.appSecret && !verifySignature(config.whatsapp.appSecret, body, req.header('x-hub-signature-256'))) return res.sendStatus(401);
    res.sendStatus(200); // ack fast; Meta retries on slow responses
    try {
      for (const m of parseWhatsAppWebhook(JSON.parse(body.toString('utf8')))) {
        if (!recordWebhookEvent('whatsapp', m.id)) continue;
        const conv = findOrCreateForPhone(m.from, 'whatsapp', m.name);
        // The sender's WhatsApp number is verified by Meta, so it counts as the phone half of verification.
        if (!conv.candidate_phone && !conv.verified_phone) updateConversation(conv.id, { candidate_phone: m.from.replace(/\D/g, '').slice(-10) } as any);
        await handleCustomerMessage(conv.id, m.text, { payload: m.payload, clientMessageId: m.id });
      }
    } catch (e: any) { log.error('whatsapp inbound failed', { error: e.message }); }
  });
  return r;
}
