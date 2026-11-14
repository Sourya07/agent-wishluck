/**
 * WhatsApp Cloud API adapter (optional — enabled when WHATSAPP_TOKEN is set).
 * Inbound: GET verification + POST webhook (X-Hub-Signature-256 checked) → same agent engine as web chat.
 * Outbound: plain text, reply buttons (≤3) or a list message (4+ options, e.g. COD confirmation).
 */
import { config } from '../config.js';
import { fetchJson } from '../lib/http.js';
import { log } from '../lib/logger.js';
import type { Button } from '../agent/templates.js';

const url = () => `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/messages`;

export async function sendWhatsApp(toPhone: string, text: string, buttons?: Button[]) {
  if (!config.whatsapp.enabled) return;
  const to = `91${toPhone.replace(/\D/g, '').slice(-10)}`;
  let body: any;
  if (!buttons?.length) body = { messaging_product: 'whatsapp', to, type: 'text', text: { body: text.slice(0, 4096), preview_url: true } };
  else if (buttons.length <= 3) body = {
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: { type: 'button', body: { text: text.slice(0, 1024) }, action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id.slice(0, 256), title: b.label.slice(0, 20) } })) } },
  };
  else body = {
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: { type: 'list', body: { text: text.slice(0, 1024) }, action: { button: 'Choose', sections: [{ title: 'Options', rows: buttons.slice(0, 10).map((b) => ({ id: b.id.slice(0, 200), title: b.label.slice(0, 24) })) }] } },
  };
  try {
    await fetchJson(url(), { method: 'POST', body, headers: { authorization: `Bearer ${config.whatsapp.token}` }, timeoutMs: 8000, retries: 2, label: 'whatsapp.send' });
  } catch (e: any) {
    log.error('whatsapp send failed', { error: e.message, to });
  }
}

/** Extracts {from, text, payload, id} from a Cloud API webhook body. */
export function parseWhatsAppWebhook(body: any): { from: string; name?: string; text: string; payload?: string; id: string }[] {
  const out: any[] = [];
  for (const entry of body?.entry ?? []) for (const ch of entry.changes ?? []) {
    const v = ch.value ?? {};
    const name = v.contacts?.[0]?.profile?.name;
    for (const m of v.messages ?? []) {
      if (m.type === 'text') out.push({ from: m.from, name, text: m.text.body, id: m.id });
      else if (m.type === 'interactive') {
        const r = m.interactive.button_reply ?? m.interactive.list_reply;
        out.push({ from: m.from, name, text: r?.title ?? '', payload: r?.id, id: m.id });
      } else if (m.type === 'button') out.push({ from: m.from, name, text: m.button.text, payload: m.button.payload, id: m.id });
      else out.push({ from: m.from, name, text: `[${m.type} message]`, id: m.id });
    }
  }
  return out;
}
