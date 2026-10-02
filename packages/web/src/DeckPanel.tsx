import { useState } from 'react';
import type { Board, Card, DeckDetail, DeckEntry, DeckSummary } from '@grimoire/shared';
import { COMMANDER_DECK_SIZE } from '@grimoire/shared';
import { api } from './api';

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
  onCreate: (name: string) => void;
  onDelete: (id: number) => void;
  onChange: (detail: DeckDetail) => void;
  onDecksChanged: () => void;
  onError: (message: string) => void;
}

export function DeckPanel({ decks, current, onSelect, onCreate, onDelete, onChange, onDecksChanged, onError }: Props) {
  const [showImport, setShowImport] = useState(false);
  const [copied, setCopied] = useState(false);

  const deck = current?.deck;
  const run = async (fn: () => Promise<DeckDetail>) => {
    try { onChange(await fn()); } catch (e) { onError((e as Error).message); }
  };
  const setQty = (e: DeckEntry, board: Board, qty: number) => run(() => api.setCard(deck!.id, e.card.id, board, qty));

  const rename = async () => {
    const name = window.prompt('Deck name', deck!.name);
    if (!name?.trim()) return;
    try { await api.renameDeck(deck!.id, name); onDecksChanged(); onChange({ ...current!, deck: { ...deck!, name: name.trim() } }); } catch (e) { onError((e as Error).message); }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(await api.exportText(deck!.id, 'sectioned'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
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

  const row = (e: DeckEntry, board: Board) => (
    <li className="row" key={e.card.id}>
      <span className="qty">{e.qty}</span>
      <a className="rname" href={e.card.scryfallUri} target="_blank" rel="noreferrer" title={e.card.typeLine}>{e.card.name}</a>
      <span className="cost">{e.card.manaCost}</span>
      <span className="actions">
        <button onClick={() => setQty(e, board, e.qty - 1)} aria-label={`Remove one ${e.card.name}`}>−</button>
        <button onClick={() => setQty(e, board, e.qty + 1)} aria-label={`Add one ${e.card.name}`}>+</button>
        {board !== 'commander' && <button onClick={() => setQty(e, 'commander', 1)} title="Make commander" aria-label={`Make ${e.card.name} commander`}>★</button>}
        {board !== 'main' && <button onClick={() => setQty(e, 'main', e.qty)} title="Move to main deck" aria-label={`Move ${e.card.name} to main deck`}>↑</button>}
        {board === 'main' && <button onClick={() => setQty(e, 'sideboard', e.qty)} title="Move to sideboard" aria-label={`Move ${e.card.name} to sideboard`}>↓</button>}
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
        <button onClick={() => { const n = window.prompt('New deck name', 'New deck'); if (n?.trim()) onCreate(n); }}>New</button>
        <button onClick={() => setShowImport(true)}>Import</button>
      </div>

      {deck && current && (
        <>
          <div className="deckhead">
            <h2 title="Rename" onClick={rename}>{deck.name}</h2>
            <span className={total === COMMANDER_DECK_SIZE ? 'count ok' : 'count'}>{total}/{COMMANDER_DECK_SIZE}</span>
          </div>
          <div className="deckbar">
            <button onClick={copy}>{copied ? 'Copied' : 'Copy list'}</button>
            <a className="btn" href={api.exportUrl(deck.id, 'sectioned')} download>Download</a>
            <button className="danger" onClick={() => { if (window.confirm(`Delete "${deck.name}"?`)) onDelete(deck.id); }}>Delete</button>
          </div>

          {current.issues.length > 0 && (
            <ul className="issues" aria-label="Deck issues">
              {current.issues.map((i, k) => <li key={k} className={i.severity}>{i.message}</li>)}
            </ul>
          )}
          {current.issues.length === 0 && <p className="valid">Valid Commander deck ✓</p>}

          <h3>Commander</h3>
          <ul className="list">{commanders.length ? commanders.map((e) => row(e, 'commander')) : <li className="empty">Use ★ on a card to set the commander.</li>}</ul>

          {order.filter((g) => groups.has(g)).map((g) => {
            const list = groups.get(g)!;
            return (
              <section key={g}>
                <h3>{g} <small>({list.reduce((n, e) => n + e.qty, 0)})</small></h3>
                <ul className="list">{list.map((e) => row(e, 'main'))}</ul>
              </section>
            );
          })}

          {side.length > 0 && (
            <section>
              <h3>Sideboard <small>({side.reduce((n, e) => n + e.qty, 0)})</small></h3>
              <ul className="list">{side.map((e) => row(e, 'sideboard'))}</ul>
            </section>
          )}
        </>
      )}
      {!deck && <p className="empty">Create a deck to start building.</p>}

      {showImport && (
        <ImportDialog
          currentId={deck?.id}
          onClose={() => setShowImport(false)}
          onImported={(detail) => { onChange(detail); onDecksChanged(); }}
          onError={onError}
        />
      )}
    </aside>
  );
}

function ImportDialog({ currentId, onClose, onImported, onError }: {
  currentId?: number; onClose: () => void; onImported: (d: DeckDetail) => void; onError: (m: string) => void;
}) {
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [target, setTarget] = useState<'new' | 'replace'>('new');
  const [unresolved, setUnresolved] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const res = await api.importDeck(text, target === 'replace' && currentId !== undefined ? { deckId: currentId } : { name: name || undefined });
      onImported(res);
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
          {currentId !== undefined && <label><input type="radio" checked={target === 'replace'} onChange={() => setTarget('replace')} /> Replace current deck</label>}
        </div>
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
