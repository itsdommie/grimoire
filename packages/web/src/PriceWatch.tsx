import { useEffect, useState } from 'react';
import type { PriceMover, PriceReport } from '@grimoire/shared';
import { api } from './api';
import { usd } from './CollectionView';

const WINDOWS = [7, 30, 90] as const;
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${usd(Math.abs(n))}`;

function MoverRows({ title, rows, onOpenCard }: { title: string; rows: PriceMover[]; onOpenCard: (id: string) => void }) {
  if (rows.length === 0) return null;
  return (
    <>
      <h4>{title}</h4>
      <ul className="list pricerows" aria-label={title}>
        {rows.map((m) => (
          <li key={m.card.id} className="row pricerow">
            <button className="linklike rname" onClick={() => onOpenCard(m.card.id)}>{m.card.name}</button>
            <span className="muted small">{usd(m.then)} → {usd(m.now)}</span>
            <span className={m.change > 0 ? 'rise' : 'fall'}><span aria-hidden>{m.change > 0 ? '▲' : '▼'}</span> {signed(m.change)}{m.pct !== null && <span className="small"> ({m.pct > 0 ? '+' : m.pct < 0 ? '−' : ''}{Math.abs(m.pct)}%)</span>}</span>
            <span className="muted small" title="The change times the copies you own (or still need)">{m.owned > 0 ? `${m.owned} owned` : `want ${m.wanted}`}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * How the prices of the cards you own, want or use in decks have moved. Scryfall only gives today's price, so Brewhall notes each card's
 * price as it changes and this fills in over time. `scope` narrows it to the collection or the wishlist.
 */
export function PriceWatch({ scope, version, onOpenCard }: { scope: 'all' | 'collection' | 'wishlist'; version: number; onOpenCard: (id: string) => void }) {
  const [days, setDays] = useState<number>(30);
  const [report, setReport] = useState<PriceReport | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    api.prices(days, scope, c.signal).then((r) => { setReport(r); setFailed(false); }).catch((e: Error) => { if (e.name !== 'AbortError') setFailed(true); });
    return () => c.abort();
  }, [days, scope, version]);
  if (failed || !report) return null;

  const moved = report.up.length + report.down.length;
  const change = report.valueNow - report.valueThen;
  const headline = scope === 'wishlist'
    ? (report.down.length > 0 ? `${report.down.length} cheaper, ${report.up.length} dearer` : moved > 0 ? `${report.up.length} dearer` : 'no change yet')
    : (moved === 0 ? 'no change yet' : scope !== 'collection' && report.valueNow > 0 ? `your cards ${change >= 0 ? 'up' : 'down'} ${usd(Math.abs(change))}` : `${moved} cards moved`);
  return (
    <details className="pricewatch">
      <summary>Price watch <span className="muted small">· {headline} in {days} days</span></summary>
      <span className="seg" role="group" aria-label="Time window">
        {WINDOWS.map((d) => <button key={d} className={days === d ? 'active' : ''} aria-pressed={days === d} onClick={() => setDays(d)}>{d} days</button>)}
      </span>
      {report.since === null || moved === 0
        ? <p className="muted small">{report.since === null ? 'Not watching any prices yet.' : `Watching ${report.tracked.toLocaleString()} ${report.tracked === 1 ? 'card' : 'cards'} since ${report.since}. Nothing has moved in this time yet.`} Scryfall only publishes today's prices, so Brewhall notes each card's price as it changes and this fills in as they do.</p>
        : (
          <>
            {scope !== 'wishlist' && report.valueThen > 0 && <p className="statline">The cards you own are worth about <strong>{usd(report.valueNow)}</strong>, {change === 0 ? 'the same as' : <><strong>{signed(change)}</strong> from</>} {usd(report.valueThen)} {days} days ago{report.since && report.since > new Date(Date.now() - days * 864e5).toISOString().slice(0, 10) ? <span className="muted small"> (watched since {report.since})</span> : null}.</p>}
            <MoverRows title={scope === 'wishlist' ? 'Cheaper now' : 'Fallers'} rows={report.down} onOpenCard={onOpenCard} />
            <MoverRows title={scope === 'wishlist' ? 'Dearer now' : 'Risers'} rows={report.up} onOpenCard={onOpenCard} />
            <p className="muted small">Each card at its cheapest printing (Scryfall's prices, a rough guide). Ranked by what the change means for you: the change times the copies you own, or still need.</p>
          </>
        )}
    </details>
  );
}
