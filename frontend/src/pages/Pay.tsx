import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { ErrorState, Loading, Spinner } from '../components/ui';
import { ICheck, IShield } from '../components/icons';
import { api } from '../lib/api';
import { inr } from '../lib/format';
import { useApi } from '../lib/hooks';

/** Dummy payment gateway used when a customer switches a COD order to prepaid. */
export default function Pay() {
  const { orderId } = useParams();
  const [sp] = useSearchParams();
  const token = sp.get('t') ?? '';
  const info = useApi<any>(`/payments/${orderId}?t=${encodeURIComponent(token)}`);
  const [state, setState] = useState<'idle' | 'paying' | 'done' | 'error'>('idle');
  const [err, setErr] = useState('');
  const pay = async () => {
    setState('paying');
    try { await new Promise((r) => setTimeout(r, 700)); await api(`/payments/${orderId}/complete`, { body: { t: token } }); setState('done'); }
    catch (e: any) { setErr(e.message); setState('error'); }
  };
  const p = info.data;
  return (
    <div className="center-page">
      <div className="card pay-card">
        <div className="card-h"><IShield width={17} /><h3>Wishluck secure checkout</h3><span className="badge dashed" style={{ marginLeft: 'auto' }}>Test mode</span></div>
        <div className="card-b col" style={{ gap: 14 }}>
          {info.loading ? <Loading rows={3} /> : info.error ? <ErrorState error="This payment link is invalid or expired" /> : state === 'done' || p.payment_method === 'prepaid' ? (
            <div className="col" style={{ alignItems: 'center', textAlign: 'center', padding: '18px 0' }}>
              <div className="avatar ink" style={{ width: 48, height: 48 }}><ICheck width={22} /></div>
              <div className="strong" style={{ fontSize: 16 }}>Payment received</div>
              <div className="small muted">Order {orderId} is now prepaid and will ship soon. You can close this page — we've sent a confirmation in chat.</div>
            </div>
          ) : (
            <>
              <div className="small muted">Order {p.orderId} · {p.name}</div>
              <div className="col" style={{ gap: 4 }}>{p.items.map((i: any) => <div key={i.id} className="row small"><span className="grow">{i.name}{i.size && i.size !== 'ONE' ? ` (${i.size})` : ''} × {i.qty}</span><span>{inr(i.price * i.qty)}</span></div>)}</div>
              <div className="divider" style={{ margin: 0 }} />
              <div className="row small"><span className="grow muted">Shipping</span><span>{p.shipping_fee ? inr(p.shipping_fee) : 'Free'}</span></div>
              {p.existing_discount > 0 && <div className="row small"><span className="grow muted">Order discount</span><span>−{inr(p.existing_discount)}</span></div>}
              <div className="row small"><span className="grow muted">COD fee</span><span><s className="muted">{inr(p.cod_fee)}</s> waived</span></div>
              <div className="row small"><span className="grow muted">Prepaid discount (5% of items)</span><span>−{inr(p.discount)}</span></div>
              <div className="row tiny muted"><span className="grow">You would have paid on delivery</span><s>{inr(p.cod_total)}</s></div>
              <div className="row"><span className="grow strong">Pay now</span><span className="strong" style={{ fontSize: 20 }}>{inr(p.payable)}</span></div>
              <button className="btn primary" style={{ height: 42 }} disabled={state === 'paying'} onClick={pay}>{state === 'paying' ? <><Spinner size={14} /> Processing…</> : `Pay ${inr(p.payable)}`}</button>
              {state === 'error' && <div className="small" role="alert">✕ {err}</div>}
              <div className="tiny muted" style={{ textAlign: 'center' }}>Dummy gateway for the assignment — no real money moves.</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
