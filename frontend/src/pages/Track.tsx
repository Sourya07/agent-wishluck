import { useParams } from 'react-router-dom';
import { ErrorState, Loading } from '../components/ui';
import { ITruck } from '../components/icons';
import { dateTime, label } from '../lib/format';
import { useApi } from '../lib/hooks';

export default function Track() {
  const { awb } = useParams();
  const t = useApi<any>(`/track/${awb}`);
  return (
    <div className="center-page">
      <div className="card pay-card" style={{ width: 'min(520px, 100%)' }}>
        <div className="card-h"><ITruck width={18} /><h3>Track shipment</h3><span className="mono muted" style={{ marginLeft: 'auto' }}>{awb}</span></div>
        <div className="card-b">
          {t.loading ? <Loading rows={3} /> : t.error ? <ErrorState error={t.error} onRetry={() => t.reload()} /> : (
            <>
              <div className="row" style={{ marginBottom: 14 }}><span className="badge solid">{label(t.data.status)}</span><span className="small muted">by {t.data.courier} · order {t.data.order_id}</span></div>
              {t.data.scheduled_date && <p className="small">Next delivery attempt: <b>{t.data.scheduled_date}</b></p>}
              <div className="timeline">
                {[...t.data.timeline].reverse().map((e: any, i: number) => (
                  <div key={i} className={`tl ${i === 0 ? 'cur' : ''}`}><div className="row"><span className="strong">{label(e.status)}</span><span className="tiny muted">{dateTime(e.at)}</span></div>{(e.location || e.note) && <div className="small muted">{[e.location, e.note].filter(Boolean).join(' · ')}</div>}</div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
