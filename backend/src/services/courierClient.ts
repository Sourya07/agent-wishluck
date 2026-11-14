import { config } from '../config.js';
import { fetchJson } from '../lib/http.js';

const base = () => config.courier.baseUrl;
const opts = { timeoutMs: config.courier.timeoutMs, retries: 2 };

export interface Tracking { awb: string; order_id: string; status: string; attempts: number; scheduled_date: string | null; timeline: { at: string; status: string; note?: string; location?: string }[]; courier: string }

export const courier = {
  createShipment: (orderId: string, consignee: Record<string, unknown>) =>
    fetchJson<{ awb: string }>(`${base()}/shipments`, { ...opts, method: 'POST', body: { order_id: orderId, consignee }, label: 'courier.create' }),
  track: (awb: string) => fetchJson<Tracking>(`${base()}/shipments/${encodeURIComponent(awb)}`, { ...opts, label: 'courier.track' }),
  ndr: (awb: string, body: Record<string, unknown>) =>
    fetchJson<{ ok: boolean; status: string; note: string }>(`${base()}/shipments/${encodeURIComponent(awb)}/ndr`, { ...opts, method: 'POST', body, label: 'courier.ndr' }),
  event: (awb: string, body: Record<string, unknown>) =>
    fetchJson(`${base()}/shipments/${encodeURIComponent(awb)}/events`, { ...opts, retries: 0, method: 'POST', body, label: 'courier.event' }),
  trackingUrl: (awb: string) => `${config.frontendUrl}/track/${awb}`,
};
