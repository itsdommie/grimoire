import { useState } from 'react';
import { useEffect } from 'react';
import type { Board, Card, CollectionSummary, DeckDetail, DeckEntry, DeckSummary, MissingReport } from '@grimoire/shared';
import { FORMATS, FORMAT_IDS, isBasicLand, reservesCopies, type FormatId } from '@grimoire/shared';
import { api } from './api';
import { AnalysisView } from './AnalysisView';
import { SimulateView } from './SimulateView';
import { SkipUsedToggle, usd } from './CollectionView';
import { useBack } from './backstack';

const GROUPS = ['Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Battle', 'Land'] as const;

/** Primary type for grouping. Lands win over everything ("Artifact Land"), then the usual priority. */
export function typeGroup(card: Card): string {
  const front = card.typeLine.split(' // ')[0] ?? '';
  if (/\bLand\b/.test(front)) return 'Land';
  return GROUPS.find((g) => new RegExp(`\\b${g}\\b`).test(front)) ?? 'Other';
}

interface Props {
  decks: DeckSummary[];
  current: DeckDetail | null;
  onSelect: (id: number) => void;
  onCreate: (name: string, format: FormatId) => void;
  onDelete: (id: number) => void;
  onChange: (detail: DeckDetail) => void;
  onDecksChanged: () => void;
  onError: (message: string) => void;
  collection: CollectionSummary | null;
  collectionVersion: number;
  /** After a deck's cards were added to the collection. */
  onCollectionChanged: () => Promise<void>;
  skipUsed: boolean;
  onSkipUsed: (v: boolean) => void;
  onOpenCard: (id: string) => void;
  cheapest: boolean;
}

export function DeckPanel({ decks, current, onSelect, onCreate, onDelete, onChange, onDecksChanged, onError, collection, collectionVersion, onCollectionChanged, skipUsed, onSkipUsed, onOpenCard, cheapest }: Props) {
  const [showImport, setShowImport] = useState(false);
  // window.prompt() isn't available in Electron, so naming uses an in-app dialog.
  const [naming, setNaming] = useState<'new' | 'rename' | null>(null);
  const [tab, setTab] = useState<'deck' | 'analysis' | 'simulate'>('deck');
  const [copied, setCopied] = useState(false);
  const [addedNote, setAddedNote] = useState<string | null>(null);

  const deck = current?.deck;
  const rules = FORMATS[deck?.format ?? 'commander'];
  const sideCount = (current?.entries ?? []).filter((e) => e.board === 'sideboard').reduce((n, e) => n + e.qty, 0);
  const changeFormat = async (format: FormatId) => {
    try { await api.updateDeck(deck!.id, { format }); onChange(await api.getDeck(deck!.id)); onDecksChanged(); } catch (e) { onError((e as Error).message); }
  };
  const run = async (fn: () => Promise<DeckDetail>) => {
    try { onChange(await fn()); } catch (e) { onError((e as Error).message); }
  };
  const setQty = (e: DeckEntry, board: Board, qty: number) => run(() => api.setCard(deck!.id, e.card.id, board, qty));
  /** Relocate a stack to another board, merging with any copies already there. */
  const moveTo = (e: DeckEntry, board: Board) => run(() => api.setCard(deck!.id, e.card.id, board, e.qty + (current?.entries.find((x) => x.card.id === e.card.id && x.board === board)?.qty ?? 0), true));

  const rename = async (name: string) => {
    try { await api.renameDeck(deck!.id, name); onDecksChanged(); onChange({ ...current!, deck: { ...deck!, name: name.trim() } }); } catch (e) { onError((e as Error).message); }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(await api.exportText(deck!.id, 'sectioned'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) { onError((e as Error).message); }
  };

  const download = async () => {
    try {
      const text = await api.exportText(deck!.id, 'sectioned');
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: `${deck!.name.replace(/[^\w.-]+/g, '_')}.txt` });
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { onError((e as Error).message); }
  };

  const groups = new Map<string, DeckEntry[]>();
  for (const e of current?.entries ?? []) {
    if (e.board !== 'main') continue;
    const g = typeGroup(e.card);
    groups.set(g, [...(groups.get(g) ?? []), e]);
  }
  const order = [...GROUPS, 'Other'];
  const commanders = current?.entries.filter((e) => e.board === 'commander') ?? [];
  const side = current?.entries.filter((e) => e.board === 'sideboard') ?? [];

  const haveCollection = (collection?.total ?? 0) > 0;
  /** Copies of each card this deck holds (a Commander maybeboard holds none), to tell its own copies from other decks'. */
  const heldHere = new Map<string, number>();
  for (const e of current?.entries ?? []) if (reservesCopies(rules.id, e.board)) heldHere.set(e.card.id, (heldHere.get(e.card.id) ?? 0) + e.qty);
  /** Copies available to this deck: all of them, or (skipping used ones) only those no other deck has. */
  const availableTo = (card: Card) => (card.owned ?? 0) - (skipUsed ? Math.max(0, (card.inDecks ?? 0) - (heldHere.get(card.id) ?? 0)) : 0);
  const addToCollection = async () => {
    if (!deck) return;
    const n = (current?.entries ?? []).filter((e) => reservesCopies(rules.id, e.board) && !isBasicLand(e.card)).reduce((sum, e) => sum + e.qty, 0);
    if (!window.confirm(`Add the ${n} cards in "${deck.name}" to your collection?\n\nBasic lands${rules.commander ? ' and the maybeboard are' : ' are'} skipped. Only do this for a deck that isn't in your collection already: adding it again adds another copy of every card.`)) return;
    try {
      const r = await api.addDeckToCollection(deck.id);
      setAddedNote(`Added ${r.added} cards`);
      setTimeout(() => setAddedNote(null), 4000);
      await onCollectionChanged();
    } catch (e) { onError((e as Error).message); }
  };
  const row = (e: DeckEntry, board: Board) => (
    <li className="row" key={e.card.id}>
      <span className="qty">{e.qty}</span>
      <button className="rname linklike" onClick={() => onOpenCard(e.card.id)} title={e.card.typeLine}>{e.card.name}</button>
      {haveCollection && board !== 'sideboard' && !isBasicLand(e.card) && availableTo(e.card) < e.qty && <span className="missing" title={skipUsed ? 'Not enough spare copies: the rest are in your other decks' : 'Not enough copies in your collection'} aria-label="Missing from collection">✗</span>}
      <span className="cost">{e.card.manaCost}</span>
      <span className="actions">
        <button onClick={() => setQty(e, board, e.qty - 1)} aria-label={`Remove one ${e.card.name}`}>−</button>
        <button onClick={() => setQty(e, board, e.qty + 1)} aria-label={`Add one ${e.card.name}`}>+</button>
        {rules.commander && board !== 'commander' && <button onClick={() => setQty(e, 'commander', 1)} title="Make commander" aria-label={`Make ${e.card.name} commander`}>★</button>}
        {board !== 'main' && <button onClick={() => moveTo(e, 'main')} title="Move to main deck" aria-label={`Move ${e.card.name} to main deck`}>↑</button>}
        {board === 'main' && <button onClick={() => moveTo(e, 'sideboard')} title="Move to sideboard" aria-label={`Move ${e.card.name} to sideboard`}>↓</button>}
        <button onClick={() => setQty(e, board, 0)} title="Remove" aria-label={`Remove ${e.card.name}`}>×</button>
      </span>
    </li>
  );

  const total = current?.deck.cardCount ?? 0;

  return (
    <aside className="deck">
      <div className="deckbar">
        <select value={deck?.id ?? ''} onChange={(e) => onSelect(Number(e.target.value))} aria-label="Deck">
          {decks.length === 0 && <option value="">No decks yet</option>}
          {decks.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.cardCount})</option>)}
        </select>
        <button onClick={() => setNaming('new')}>New</button>
        <button onClick={() => setShowImport(true)}>Import</button>
      </div>

      {deck && current && (
        <>
          <div className="deckhead">
            <h2 title="Rename" onClick={() => setNaming('rename')}>{deck.name}</h2>
            <span className={(rules.commander ? total === rules.deckSize : total >= rules.deckSize) ? 'count ok' : 'count'} title={rules.commander ? 'Cards including the commander' : 'Main deck cards (minimum 60)'}>{total}/{rules.deckSize}{rules.commander ? '' : '+'}</span>
          </div>
          <div className="deckbar">
            <label className="fmt">Format
              <select value={deck.format} aria-label="Format" onChange={(e) => void changeFormat(e.target.value as FormatId)}>
                {FORMAT_IDS.map((f) => <option key={f} value={f}>{FORMATS[f].name}</option>)}
              </select>
            </label>
            {!rules.commander && <span className="muted small">Sideboard {sideCount}/{rules.maxSideboard}</span>}
          </div>
          <div className="deckbar">
            <button onClick={copy}>{copied ? 'Copied' : 'Copy list'}</button>
            <button onClick={download}>Download</button>
            <button onClick={() => void addToCollection()} title="Add this deck's cards to your collection (for decks your collection export doesn't include)">{addedNote ?? 'Add to collection'}</button>
            <button className="danger" onClick={() => { if (window.confirm(`Delete "${deck.name}"?`)) onDelete(deck.id); }}>Delete</button>
          </div>

          <div className="tabs" role="tablist" aria-label="Deck views">
            {([['deck', 'Deck'], ['analysis', 'Analysis'], ['simulate', 'Simulate']] as const).map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>

          {tab === 'analysis' && <AnalysisView entries={current.entries} format={deck.format} />}
          {/* Kept mounted (just hidden) so results survive tab switches and can be flagged stale when the deck changes. */}
          <div hidden={tab !== 'simulate'}><SimulateView key={deck.id} entries={current.entries} format={deck.format} /></div>

          {tab === 'deck' && <>
          {current.issues.length > 0 && (
            <ul className="issues" aria-label="Deck issues">
              {current.issues.map((i, k) => <li key={k} className={i.severity}>{i.message}</li>)}
            </ul>
          )}
          {current.issues.length === 0 && <p className="valid">Valid Commander deck ✓</p>}

          {haveCollection && <MissingPanel deckId={deck.id} entries={current.entries} version={collectionVersion} cheapest={cheapest} skipUsed={skipUsed} onSkipUsed={onSkipUsed} />}

          {rules.commander && <>
            <h3>Commander</h3>
            <ul className="list">{commanders.length ? commanders.map((e) => row(e, 'commander')) : <li className="empty">Use ★ on a card to set the commander.</li>}</ul>
          </>}

          {order.filter((g) => groups.has(g)).map((g) => {
            const list = groups.get(g)!;
            return (
              <section key={g}>
                <h3>{g} <small>({list.reduce((n, e) => n + e.qty, 0)})</small></h3>
                <ul className="list">{list.map((e) => row(e, 'main'))}</ul>
              </section>
            );
          })}

          {(side.length > 0 || !rules.commander) && (
            <section>
              <h3>{rules.commander ? 'Maybeboard' : 'Sideboard'} <small>({sideCount}{rules.commander ? '' : `/${rules.maxSideboard}`})</small></h3>
              <ul className="list">{side.length ? side.map((e) => row(e, 'sideboard')) : <li className="empty">Use ↓ on a deck card, or "+ Side" on a search result.</li>}</ul>
            </section>
          )}
          </>}
        </>
      )}
      {!deck && <p className="empty">Create a deck to start building.</p>}

      {naming && (
        <NameDialog
          title={naming === 'new' ? 'New deck' : 'Rename deck'}
          initial={naming === 'new' ? 'New deck' : deck!.name}
          confirmLabel={naming === 'new' ? 'Create' : 'Rename'}
          onCancel={() => setNaming(null)}
          withFormat={naming === 'new'}
          onSubmit={(name, format) => { setNaming(null); if (naming === 'new') onCreate(name, format); else void rename(name); }}
        />
      )}

      {showImport && (
        <ImportDialog
          currentId={deck?.id}
          onClose={() => setShowImport(false)}
          onImported={(detail, addedToCollection) => { onChange(detail); onDecksChanged(); if (addedToCollection) void onCollectionChanged(); }}
          onError={onError}
        />
      )}
    </aside>
  );
}

function ImportDialog({ currentId, onClose, onImported, onError }: {
  currentId?: number; onClose: () => void; onImported: (d: DeckDetail, addedToCollection: boolean) => void; onError: (m: string) => void;
}) {
  useBack(true, onClose);
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [target, setTarget] = useState<'new' | 'replace'>('new');
  const [format, setFormat] = useState<FormatId>('commander');
  const [unresolved, setUnresolved] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [addToCollection, setAddToCollection] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const res = await api.importDeck(text, { ...(target === 'replace' && currentId !== undefined ? { deckId: currentId } : { name: name || undefined, format }), addToCollection });
      onImported(res, !!res.addedToCollection);
      if (res.unresolved.length === 0) onClose(); else setUnresolved(res.unresolved);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal" role="dialog" aria-label="Import deck">
      <div className="dialog">
        <h2>Import deck list</h2>
        <p className="hint">Paste plain text, or a Moxfield / Archidekt text export. Section headers (Commander, Deck, Sideboard) are respected.</p>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={14} placeholder={'Commander\n1 Atraxa, Praetors\' Voice\n\nDeck\n1 Sol Ring\n36 Forest'} spellCheck={false} />
        <div className="deckbar">
          <label><input type="radio" checked={target === 'new'} onChange={() => setTarget('new')} /> New deck</label>
          {target === 'new' && <input className="small" value={name} onChange={(e) => setName(e.target.value)} placeholder="Deck name" />}
          {target === 'new' && <select value={format} onChange={(e) => setFormat(e.target.value as FormatId)} aria-label="Format of the imported deck">{FORMAT_IDS.map((f) => <option key={f} value={f}>{FORMATS[f].name}</option>)}</select>}
          {currentId !== undefined && <label><input type="radio" checked={target === 'replace'} onChange={() => setTarget('replace')} /> Replace current deck</label>}
        </div>
        {!unresolved && <label className="small"><input type="checkbox" checked={addToCollection} onChange={(e) => setAddToCollection(e.target.checked)} /> Also add these cards to my collection <span className="muted">(for a deck that isn't in your collection export; basic lands are skipped)</span></label>}
        {unresolved && (
          <div className="issues"><p className="warning">Imported, but {unresolved.length} line(s) were not recognised:</p><ul>{unresolved.map((u, i) => <li key={i}>{u}</li>)}</ul></div>
        )}
        <div className="deckbar end">
          <button onClick={onClose}>{unresolved ? 'Close' : 'Cancel'}</button>
          {!unresolved && <button className="primary" disabled={busy || !text.trim()} onClick={submit}>Import</button>}
        </div>
      </div>
    </div>
  );
}

function NameDialog({ title, initial, confirmLabel, withFormat, onSubmit, onCancel }: {
  title: string; initial: string; confirmLabel: string; withFormat?: boolean; onSubmit: (name: string, format: FormatId) => void; onCancel: () => void;
}) {
  useBack(true, onCancel);
  const [name, setName] = useState(initial);
  const [format, setFormat] = useState<FormatId>('commander');
  const submit = () => { if (name.trim()) onSubmit(name.trim(), format); };
  return (
    <div className="modal" role="dialog" aria-label={title} onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <form className="dialog narrow" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <h2>{title}</h2>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} aria-label="Deck name" maxLength={100} />
        {withFormat && (
          <label className="field">Format
            <select value={format} onChange={(e) => setFormat(e.target.value as FormatId)} aria-label="New deck format">{FORMAT_IDS.map((f) => <option key={f} value={f}>{FORMATS[f].name}</option>)}</select>
          </label>
        )}
        <div className="deckbar end">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary" disabled={!name.trim()}>{confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}

/** How much of the deck you own, and what the rest would cost (rough: Scryfall's featured-printing prices). */
function MissingPanel({ deckId, entries, version, cheapest, skipUsed, onSkipUsed }: { deckId: number; entries: DeckEntry[]; version: number; cheapest: boolean; skipUsed: boolean; onSkipUsed: (v: boolean) => void }) {
  const [report, setReport] = useState<MissingReport | null>(null);
  const key = entries.filter((e) => e.board !== 'sideboard').map((e) => `${e.card.id}:${e.qty}:${e.card.owned ?? 0}:${e.card.inDecks ?? 0}`).join('|');
  useEffect(() => {
    let stop = false;
    api.deckMissing(deckId, skipUsed).then((r) => { if (!stop) setReport(r); }).catch(() => { if (!stop) setReport(null); });
    return () => { stop = true; };
  }, [deckId, key, version, skipUsed]);
  if (!report || report.needed === 0) return null;
  const done = report.missing.length === 0;
  return (
    <section className="missingpanel" aria-label="Collection coverage">
      <p className={`finding ${done ? 'ok' : 'info'}`}>
        <span className="ficon" aria-hidden>{done ? '✓' : '\u2139\uFE0E'}</span>
        <span>
          {done
            ? <strong>{skipUsed ? 'Every card in this deck is free to use, without touching your other decks.' : 'You own every card in this deck.'}</strong>
            : <><strong>{skipUsed ? `${report.have} of ${report.needed} are free` : `You own ${report.have} of ${report.needed}`}</strong> {skipUsed ? 'to use (copies in your other decks are left alone; basic lands excluded)' : 'cards (basic lands excluded)'}. Missing {report.missing.reduce((n, m) => n + m.missing, 0)} for about <strong>{usd(report.totalUsd)}</strong>{report.unpriced > 0 && ` + ${report.unpriced} unpriced`}.</>}
        </span>
      </p>
      <p className="small"><SkipUsedToggle checked={skipUsed} onChange={onSkipUsed} /></p>
      {!done && (
        <details>
          <summary>Missing cards</summary>
          <ul className="list">
            {report.missing.map((m) => (
              <li key={m.card.id} className="row">
                <span className="qty">{m.missing}</span>
                <a className="rname" href={m.card.scryfallUri} target="_blank" rel="noreferrer">{m.card.name}</a>
                <span className="cost">{m.costUsd === null ? 'no price' : usd(m.costUsd)}</span>
              </li>
            ))}
          </ul>
          <p className="muted small">{cheapest ? 'Prices are the cheapest paper printing of each card (USD, from Scryfall).' : "Prices are Scryfall's for its featured printing of each card (USD), not the cheapest copy. Turn on cheapest-printing prices at the bottom of the page."}</p>
        </details>
      )}
    </section>
  );
}
