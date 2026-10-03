import { useCallback, useEffect, useState } from 'react';
import type { WishlistReport } from '@grimoire/shared';
import { api } from './api';
import { usd } from './CollectionView';

/** The cards you want. A wish is the copies you want in total, so it fills in as your collection grows. */
export function WishlistView({ onOpenCard, version, onChanged }: { onOpenCard: (id: string) => void; version: number; onChanged: () => void }) {
  const [report, setReport] = useState<WishlistReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    try { setReport(await api.wishlist(signal)); setError(null); } catch (e) { if ((e as Error).name !== 'AbortError') setError((e as Error).message); }
  }, []);
  useEffect(() => { const c = new AbortController(); void load(c.signal); return () => c.abort(); }, [load, version]);

  const want = async (cardId: string, n: number) => {
    if (n < 0) return;
    try { setReport(await api.setWanted(cardId, n)); onChanged(); } catch (e) { setError((e as Error).message); }
  };

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!report) return <p className="muted">Loading…</p>;
  const open = report.items.filter((i) => i.need > 0);
  const got = report.items.filter((i) => i.need === 0);
  return (
    <section className="wishlist" aria-label="Wishlist">
      <div className="collbar">
        <div>
          {report.items.length === 0
            ? <strong>Your wishlist is empty.</strong>
            : <><strong>{report.open}</strong> {report.open === 1 ? 'card' : 'cards'} to find{report.open > 0 && <> · about <strong>{usd(report.totalUsd)}</strong> to buy them{report.unpriced > 0 && <span className="muted small"> ({report.unpriced} with no price)</span>}</>}</>}
          <p className="muted small">Add cards with Want in a card's details, or from a deck's missing cards. A wish counts the copies you want in total, so it ticks off as you collect them.</p>
        </div>
        {report.items.length > 0 && <div className="deckbar"><button className="danger" onClick={() => { if (window.confirm('Remove every card from your wishlist? Your collection and decks are not affected.')) void api.clearWishlist().then(() => { void load(); onChanged(); }).catch((e: Error) => setError(e.message)); }}>Clear</button></div>}
      </div>
      {open.length > 0 && <ul className="list wishrows" aria-label="Cards to find">{open.map((i) => <WishRow key={i.card.id} item={i} onOpenCard={onOpenCard} onWant={want} />)}</ul>}
      {got.length > 0 && (
        <>
          <h3>Got them <span className="muted small">({got.length})</span></h3>
          <ul className="list wishrows got" aria-label="Wishes you have met">{got.map((i) => <WishRow key={i.card.id} item={i} onOpenCard={onOpenCard} onWant={want} />)}</ul>
        </>
      )}
    </section>
  );
}

function WishRow({ item: i, onOpenCard, onWant }: { item: WishlistReport['items'][number]; onOpenCard: (id: string) => void; onWant: (id: string, n: number) => void }) {
  return (
    <li className="row wishrow">
      {i.card.imageUrl && <img src={i.card.imageUrl} alt="" loading="lazy" />}
      <button className="linklike rname" onClick={() => onOpenCard(i.card.id)}>{i.card.name}</button>
      <span className="muted small">{i.need > 0 ? `own ${i.owned} of ${i.want}` : `own ${i.owned}`}</span>
      <span className="cost">{i.need === 0 ? '✓' : i.costUsd === null ? 'no price' : usd(i.costUsd)}</span>
      <span className="stepper" role="group" aria-label={`Copies of ${i.card.name} you want`}>
        <button onClick={() => onWant(i.card.id, i.want - 1)} aria-label={`Want one fewer ${i.card.name}`}>−</button>
        <span>{i.want}</span>
        <button onClick={() => onWant(i.card.id, i.want + 1)} aria-label={`Want one more ${i.card.name}`}>+</button>
      </span>
    </li>
  );
}
