import { useEffect, useState } from 'react';
import type { BanlistFormat, BanlistReport, Card } from '@grimoire/shared';
import { api } from './api';

function BanTile({ card, onOpenCard }: { card: Card; onOpenCard: (id: string) => void }) {
  const owned = card.owned ?? 0;
  return (
    <div className={`tile settile${owned > 0 ? ' have' : ''}`}>
      <div className="art">
        <button className="imglink" onClick={() => onOpenCard(card.id)} aria-label={`Details for ${card.name}`}>
          {card.imageUrl ? <img src={card.imageUrl} alt="" loading="lazy" /> : <span className="noimg">{card.name}</span>}
        </button>
        {owned > 0 && <span className="badge own">Own ×{owned}</span>}
      </div>
      <span className="name">{card.name}</span>
    </div>
  );
}

function Group({ title, note, cards, onOpenCard }: { title: string; note?: string; cards: Card[]; onOpenCard: (id: string) => void }) {
  if (cards.length === 0) return null;
  return (
    <section aria-label={title}>
      <h3>{title} <span className="muted small">({cards.length})</span></h3>
      {note && <p className="muted small">{note}</p>}
      <div className="grid">{cards.map((c) => <BanTile key={c.id} card={c} onOpenCard={onOpenCard} />)}</div>
    </section>
  );
}

/** What is banned or restricted in each format, and which of those cards you own. It is as current as the card data (updated weekly). */
export function BanlistView({ onOpenCard }: { onOpenCard: (id: string) => void }) {
  const [formats, setFormats] = useState<BanlistFormat[] | null>(null);
  const [format, setFormat] = useState('commander');
  const [report, setReport] = useState<BanlistReport | null>(null);
  const [mine, setMine] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.banlistFormats().then((r) => setFormats(r.formats)).catch((e: Error) => setError(e.message)); }, []);
  useEffect(() => {
    const c = new AbortController();
    setReport(null);
    api.banlist(format, c.signal).then((r) => { setReport(r); setError(null); }).catch((e: Error) => { if (e.name !== 'AbortError') setError(e.message); });
    return () => c.abort();
  }, [format]);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!formats) return <p className="muted">Loading…</p>;
  if (formats.length === 0) return <p className="muted">No legality data is loaded yet. Update the card data first (the footer shows how).</p>;
  const keep = (cards: Card[]) => (mine ? cards.filter((c) => (c.owned ?? 0) > 0) : cards);
  const ownedBanned = report ? report.banned.filter((c) => (c.owned ?? 0) > 0).length : 0;
  const ownedRestricted = report ? report.restricted.filter((c) => (c.owned ?? 0) > 0).length : 0;
  return (
    <section className="banlists" aria-label="Banlists">
      <span className="seg wrap" role="group" aria-label="Format">
        {formats.map((f) => <button key={f.id} className={format === f.id ? 'active' : ''} aria-pressed={format === f.id} onClick={() => setFormat(f.id)}>{f.label}</button>)}
      </span>
      {!report && <p className="muted">Loading…</p>}
      {report && (
        <>
          <p className="statline">
            <strong>{report.banned.length.toLocaleString()}</strong> banned{report.restricted.length > 0 && <>, <strong>{report.restricted.length}</strong> restricted</>} in {report.format.label}.
            {' '}{ownedBanned + ownedRestricted > 0
              ? <>You own <strong>{ownedBanned + ownedRestricted}</strong> of them{ownedRestricted > 0 && ownedBanned > 0 ? ` (${ownedBanned} banned, ${ownedRestricted} restricted)` : ''}.</>
              : <span className="muted">You own none of them.</span>}
          </p>
          <label className="filter"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only ones I own</label>
          {mine && ownedBanned + ownedRestricted === 0 && <p className="muted">You own none of the cards banned or restricted in {report.format.label}.</p>}
          <Group title="Banned" cards={keep(report.banned)} onOpenCard={onOpenCard} />
          <Group title="Restricted" note="Allowed, but only one copy per deck." cards={keep(report.restricted)} onOpenCard={onOpenCard} />
        </>
      )}
    </section>
  );
}
