import { useEffect, useRef, useState } from 'react';
import type { Board, Card, CardDetail } from '@grimoire/shared';
import { api } from './api';
import { usd } from './CollectionView';

const FORMATS: Array<[string, string]> = [['commander', 'Commander'], ['brawl', 'Brawl'], ['standard', 'Standard'], ['pioneer', 'Pioneer'], ['modern', 'Modern'], ['legacy', 'Legacy'], ['vintage', 'Vintage'], ['pauper', 'Pauper']];
const STATUS_LABEL: Record<string, string> = { legal: 'Legal', banned: 'Banned', restricted: 'Restricted' };

interface Props {
  cardId: string;
  canAddToDeck: boolean;
  onClose: () => void;
  onAddToDeck: (card: Card, board: Board) => void;
  onOwn: (card: Card, qty: number) => void;
  onSearchTag: (slug: string) => void;
}

/** Everything about one card, offline: image (with a flip for double-faced cards), text, legality, price, rulings and function tags. */
export function CardDetailDialog({ cardId, canAddToDeck, onClose, onAddToDeck, onOwn, onSearchTag }: Props) {
  const [detail, setDetail] = useState<CardDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [back, setBack] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let stop = false;
    setDetail(null); setFailed(false); setBack(false);
    api.cardDetail(cardId).then((d) => { if (!stop) setDetail(d); }).catch(() => { if (!stop) setFailed(true); });
    return () => { stop = true; };
  }, [cardId]);
  useEffect(() => { closeRef.current?.focus(); }, [detail]);

  const card = detail?.card;
  // Ownership edits happen in the parent; mirror the new count locally so the dialog updates immediately.
  const setOwned = (qty: number) => { if (card) { onOwn(card, qty); setDetail((d) => (d ? { ...d, card: { ...d.card, owned: Math.max(0, qty) } } : d)); } };

  return (
    <div className="modal" role="dialog" aria-label={card ? `${card.name} details` : 'Card details'} onKeyDown={(e) => e.key === 'Escape' && onClose()} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog carddetail">
        <button ref={closeRef} className="closex" onClick={onClose} aria-label="Close">×</button>
        {failed && <p className="error">Couldn't load this card.</p>}
        {!detail && !failed && <p className="muted">Loading…</p>}
        {card && detail && (
          <div className="cdlayout">
            <div className="cdimg">
              {(back ? card.imageUrlBack : card.imageUrl) ? <img src={(back ? card.imageUrlBack : card.imageUrl) ?? ''} alt={`${card.name}${back ? ' (back face)' : ''}`} /> : <div className="noimg">{card.name}</div>}
              {card.imageUrlBack && <button onClick={() => setBack((b) => !b)}>{back ? 'Show front' : 'Flip card'}</button>}
            </div>
            <div className="cdbody">
              <h2>{card.name}</h2>
              <p className="cdline"><span>{card.manaCost}</span> <span className="muted">· MV {card.cmc}</span></p>
              <p className="cdtype">{card.typeLine}{card.power !== null && card.toughness !== null ? ` · ${card.power}/${card.toughness}` : ''}{card.loyalty ? ` · Loyalty ${card.loyalty}` : ''}</p>
              <p className="cdtext">{card.oracleText}</p>

              <div className="cdlegal" aria-label="Format legality">
                {FORMATS.map(([key, label]) => {
                  const status = card.legalities[key];
                  return (
                    <span key={key} className={`legal ${status ?? 'not_legal'}`}>
                      <span aria-hidden>{status === 'legal' ? '✓' : status === 'banned' ? '✗' : status === 'restricted' ? '!' : '–'}</span> {label}: {status ? STATUS_LABEL[status] ?? status : 'Not legal'}
                    </span>
                  );
                })}
              </div>

              <p className="statline">
                {card.usd !== null ? <>Price about <strong>{usd(card.usd)}</strong> <span className="muted small">(Scryfall's featured printing)</span></> : <span className="muted">No price</span>}
              </p>
              <div className="deckbar">
                <span className="stepper" role="group" aria-label="Copies owned">
                  <span className="muted small">Owned</span>
                  <button onClick={() => setOwned((card.owned ?? 0) - 1)} aria-label="Own one fewer">−</button>
                  <span>{card.owned ?? 0}</span>
                  <button onClick={() => setOwned((card.owned ?? 0) + 1)} aria-label="Own one more">+</button>
                </span>
                {canAddToDeck && <button onClick={() => onAddToDeck(card, 'main')}>+ Deck</button>}
                {canAddToDeck && <button onClick={() => onAddToDeck(card, 'commander')}>★ Commander</button>}
                <a className="btn" href={card.scryfallUri} target="_blank" rel="noreferrer">View on Scryfall</a>
              </div>

              {detail.tags.length > 0 && (
                <section aria-label="Function tags">
                  <h3>Function tags</h3>
                  <p className="tagchips">{detail.tags.map((t) => <button key={t.slug} className="tagchip" title={t.description ?? t.label} onClick={() => onSearchTag(t.slug)}>{t.label}</button>)}</p>
                  <p className="muted small">Community labels from Scryfall's Tagger. Click one to search for similar cards.</p>
                </section>
              )}

              <section aria-label="Rulings">
                <h3>Rulings {detail.rulings.length > 0 && <small>({detail.rulings.length})</small>}</h3>
                {detail.rulings.length === 0
                  ? <p className="muted small">No rulings for this card.</p>
                  : <ul className="rulings">{detail.rulings.map((r, i) => <li key={i}><span className="muted small">{r.publishedAt} · {r.source === 'wotc' ? 'Wizards' : 'Scryfall'}</span><br />{r.comment}</li>)}</ul>}
              </section>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
