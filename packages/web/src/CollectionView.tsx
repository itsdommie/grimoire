import { useEffect, useState } from 'react';
import type { Card, CollectionImportResult, CollectionSummary, CommanderIdea } from '@grimoire/shared';
import { api } from './api';

export const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Summary line and actions at the top of the collection view. */
export function CollectionBar({ summary, cheapest, onImport, onClear }: { summary: CollectionSummary | null; cheapest: boolean; onImport: () => void; onClear: () => void }) {
  const empty = !summary || summary.total === 0;
  return (
    <div className="collbar">
      <div>
        {empty
          ? <strong>Your collection is empty.</strong>
          : <><strong>{summary.total.toLocaleString()}</strong> cards · <strong>{summary.unique.toLocaleString()}</strong> unique · about <strong title={cheapest ? 'Each card at its cheapest printing: a lower bound on what your copies could sell for' : "Scryfall's price for its featured printing of each card, so treat it as a rough guide"}>{usd(summary.valueUsd)}</strong>{cheapest && <span className="muted small"> (cheapest printings)</span>}
              {summary.unpriced > 0 && <span className="muted small"> ({summary.unpriced} unpriced)</span>}</>}
        <p className="muted small">Import a CSV from ManaBox, Moxfield, Archidekt or Deckbox, or paste a list. Use + Own on a card in Cards to add copies.</p>
      </div>
      <div className="deckbar">
        <button className="primary" onClick={onImport}>Import</button>
        {!empty && <button className="danger" onClick={() => { if (window.confirm('Remove every card from your collection? Your decks are not affected.')) onClear(); }}>Clear</button>}
      </div>
    </div>
  );
}

/**
 * Whether suggestions and shortfalls count copies that are already in your decks. Off (the default) counts everything you own; on
 * counts only the spare copies, so a new deck can be built without breaking an existing one apart.
 */
export function SkipUsedToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="filter" title="Counts copies, not cards: with 5 Sol Rings and 4 decks using one each, one is still free for a new deck.">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> Skip copies already in my decks
    </label>
  );
}

/** Owned commanders ranked by how many of your cards fit them; "Build" starts a deck with that commander. */
export function CommanderIdeas({ version, skipUsed, onSkipUsed, onBuild }: { version: number; skipUsed: boolean; onSkipUsed: (v: boolean) => void; onBuild: (card: Card) => void }) {
  const [ideas, setIdeas] = useState<CommanderIdea[] | null>(null);
  useEffect(() => {
    let stop = false;
    api.commanderIdeas(skipUsed).then((r) => { if (!stop) setIdeas(r); }).catch(() => { if (!stop) setIdeas([]); });
    return () => { stop = true; };
  }, [version, skipUsed]);
  if (!ideas) return null;
  return (
    <section className="ideas" aria-label="Commander ideas">
      <h2>What can I build?</h2>
      <p className="muted small">Commanders you own, ranked by how many of your other cards are legal in their colours. Basic lands are free, so ~63 non-land cards make a full deck.</p>
      <p className="small"><SkipUsedToggle checked={skipUsed} onChange={onSkipUsed} /></p>
      {ideas.length === 0 && <p className="muted">{skipUsed ? 'No commander is free: every copy you own is already in a deck. Turn the option off to see them anyway.' : 'No commanders in your collection yet.'}</p>}
      <ul>
        {ideas.slice(0, 12).map((i) => (
          <li key={i.commander.id}>
            {i.commander.imageUrl && <img src={i.commander.imageUrl} alt="" loading="lazy" />}
            <div>
              <strong>{i.commander.name}</strong>
              <span className="muted small">{i.spells} spells + {i.playable - i.spells} lands you own</span>
              <meter min={0} max={63} low={30} high={50} optimum={63} value={Math.min(i.spells, 63)} aria-label={`${Math.min(100, Math.round((i.spells / 63) * 100))}% of a deck's spells owned`} />
              <button onClick={() => onBuild(i.commander)}>Start deck</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CollectionImportDialog({ onClose, onDone, onError }: { onClose: () => void; onDone: () => void; onError: (m: string) => void }) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CollectionImportResult | null>(null);

  const readFile = async (file: File) => { setText(await file.text()); };
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.importCollection(text, mode);
      setResult(r);
      onDone();
    } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="modal" role="dialog" aria-label="Import collection" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="dialog">
        <h2>Import collection</h2>
        {result ? (
          <>
            <p className="finding ok"><span className="ficon" aria-hidden>✓</span><span>Imported {result.imported.toLocaleString()} cards ({result.unique.toLocaleString()} unique) from a {result.format === 'text' ? 'plain list' : `${result.format === 'csv' ? 'generic' : result.format} CSV`}.{result.withPrinting ? ` ${result.withPrinting.toLocaleString()} ${result.withPrinting === 1 ? 'copy was' : 'copies were'} matched to a specific printing.` : ''}</span></p>
            {result.unresolved.length > 0 && (
              <div className="issues"><p className="warning">{result.unresolved.length} name(s) weren't recognised:</p><ul>{result.unresolved.slice(0, 50).map((u) => <li key={u}>{u}</li>)}</ul>{result.unresolved.length > 50 && <p className="muted small">…and {result.unresolved.length - 50} more.</p>}</div>
            )}
            {result.skipped.length > 0 && <div className="issues"><p className="warning">Skipped rows:</p><ul>{result.skipped.slice(0, 20).map((u) => <li key={u}>{u}</li>)}</ul></div>}
            <div className="deckbar end"><button className="primary" onClick={onClose}>Done</button></div>
          </>
        ) : (
          <>
            <p className="hint">Choose a CSV file or paste its contents (or a plain list such as "4 Lightning Bolt"). Copies are tracked per card, not per printing or foil.</p>
            <div className="deckbar"><label className="btn filebtn">Choose file…<input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(e) => e.target.files?.[0] && void readFile(e.target.files[0])} hidden /></label></div>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={12} placeholder={'Name,Quantity\nSol Ring,2\nCounterspell,1'} spellCheck={false} aria-label="Collection data" />
            <div className="deckbar">
              <label><input type="radio" checked={mode === 'merge'} onChange={() => setMode('merge')} /> Add to my collection</label>
              <label><input type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')} /> Replace my collection</label>
            </div>
            <div className="deckbar end">
              <button onClick={onClose}>Cancel</button>
              <button className="primary" disabled={busy || !text.trim()} onClick={submit}>Import</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
