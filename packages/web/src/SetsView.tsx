import { useCallback, useEffect, useState } from 'react';
import { SET_GROUPS, setGroup, setIconUrl, type SetCard, type SetDetail, type SetGroupId, type SetSummary } from '@grimoire/shared';
import { api } from './api';
import { useBack } from './backstack';
import { usd } from './CollectionView';

const PAGE = 120;
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const year = (d: string | null) => (d ? d.slice(0, 4) : '');

/** A set's symbol, hotlinked from Scryfall (black on transparent, so it is inverted for the dark theme). A set without one just shows nothing. */
function SetIcon({ code, big }: { code: string; big?: boolean }) {
  return <img className={`seticon${big ? ' big' : ''}`} src={setIconUrl(code)} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />;
}

function SetList({ onOpen }: { onOpen: (code: string) => void }) {
  const [sets, setSets] = useState<SetSummary[] | null>(null);
  const [q, setQ] = useState('');
  const [mine, setMine] = useState(false);
  const [group, setGroupFilter] = useState<SetGroupId | 'all'>('all');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.sets().then((r) => setSets(r.sets)).catch((e: Error) => setError(e.message)); }, []);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!sets) return <p className="muted">Loading sets…</p>;
  if (sets.length === 0) return <p className="muted">No printings are loaded yet, so there are no sets to browse. Update the card data first (the footer shows how).</p>;
  const needle = q.trim().toLowerCase();
  const shown = sets.filter((s) => (!mine || s.owned > 0) && (group === 'all' || setGroup(s.kind) === group) && (!needle || s.name.toLowerCase().includes(needle) || s.code === needle));
  // The type filter only appears once the printings data that carries set types is loaded.
  const groups = SET_GROUPS.filter((g) => sets.some((s) => setGroup(s.kind) === g.id));
  return (
    <>
      <div className="setsbar">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a set by name or code" aria-label="Find a set" spellCheck={false} />
        <label className="filter"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only sets I own cards from</label>
      </div>
      {groups.length > 0 && (
        <span className="seg wrap" role="group" aria-label="Kind of set">
          <button className={group === 'all' ? 'active' : ''} aria-pressed={group === 'all'} onClick={() => setGroupFilter('all')}>All</button>
          {groups.map((g) => <button key={g.id} className={group === g.id ? 'active' : ''} aria-pressed={group === g.id} onClick={() => setGroupFilter(g.id)}>{g.label}</button>)}
        </span>
      )}
      <p className="muted small">{shown.length.toLocaleString()} sets{mine || needle || group !== 'all' ? ` (of ${sets.length.toLocaleString()})` : ''}. "Owned" counts cards you have in any printing.</p>
      <ul className="setlist">
        {shown.map((s) => (
          <li key={s.code}>
            <button onClick={() => onOpen(s.code)} aria-label={`${s.name} (${s.code.toUpperCase()})`}>
              <span className="setname"><SetIcon code={s.code} /> <strong>{s.name}</strong> <span className="muted small">{s.code.toUpperCase()}{s.released ? ` · ${year(s.released)}` : ''}</span></span>
              <meter min={0} max={s.cards} value={s.owned} aria-hidden />
              <span className="setcount">{s.owned.toLocaleString()} / {s.cards.toLocaleString()}</span>
            </button>
          </li>
        ))}
      </ul>
      {shown.length === 0 && <p className="muted">No set matches.</p>}
    </>
  );
}

function SetTile({ c, onOpenCard, onCopies }: { c: SetCard; onOpenCard: (id: string) => void; onCopies: (c: SetCard, qty: number) => void }) {
  const owned = c.card.owned ?? 0;
  const elsewhere = Math.max(0, owned - c.copiesHere);
  return (
    <div className={`tile settile${owned > 0 ? ' have' : ' missing'}`}>
      <div className="art">
        <button className="imglink" onClick={() => onOpenCard(c.card.id)} aria-label={`Details for ${c.card.name}`}>
          <img src={c.imageUrl} alt="" loading="lazy" />
        </button>
        {owned > 0 && <span className="badge own" title={elsewhere > 0 ? `${owned} owned, ${c.copiesHere} recorded as this set's printing` : 'Copies of this printing'}>Own ×{owned}</span>}
      </div>
      <span className="name">{c.card.name}</span>
      <span className="printline">#{c.collector}{c.variants > 1 ? ` · ${c.variants} versions` : ''}{c.usd !== null ? ` · ${usd(c.usd)}` : ''}</span>
      <span className="stepper" role="group" aria-label={`Copies of ${c.card.name} from this set`}>
        <button onClick={() => onCopies(c, c.copiesHere - 1)} disabled={c.copiesHere === 0} aria-label={`One fewer ${c.card.name} from this set`}>−</button>
        <span>{c.copiesHere}</span>
        <button onClick={() => onCopies(c, c.copiesHere + 1)} aria-label={`One more ${c.card.name} from this set`}>+</button>
      </span>
    </div>
  );
}

function SetPage({ code, onBack, onOpenCard, onSearch, onCollectionChanged, version }: { code: string; onBack: () => void; onOpenCard: (id: string) => void; onSearch: (code: string) => void; onCollectionChanged: () => void; version: number }) {
  useBack(true, onBack);
  const [filter, setFilter] = useState<'all' | 'owned' | 'missing'>('all');
  const [detail, setDetail] = useState<SetDetail | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try { setDetail(await api.set(code, filter, limit, 0, signal)); setError(null); } catch (e) { if ((e as Error).name !== 'AbortError') setError((e as Error).message); }
  }, [code, filter, limit]);
  useEffect(() => { const c = new AbortController(); void load(c.signal); return () => c.abort(); }, [load, version]);

  // "+" says "one of the copies I have is this printing" (copies with no printing recorded are used up first); "−" takes a copy away.
  const setCopies = async (c: SetCard, qty: number) => {
    if (qty < 0) return;
    try { await api.setPrinting(c.printingId, c.finish, qty, qty > c.copiesHere); await load(); onCollectionChanged(); } catch (e) { setError((e as Error).message); }
  };

  const s = detail?.set;
  return (
    <section className="setpage" aria-label={s ? `${s.name} cards` : 'Set'}>
      <button className="linklike" onClick={onBack}>← All sets</button>
      {error && <p className="error" role="alert">{error}</p>}
      {!detail && !error && <p className="muted">Loading…</p>}
      {detail && s && (
        <>
          <h2><SetIcon code={s.code} big /> {s.name} <span className="muted small">{s.code.toUpperCase()}{s.released ? ` · ${s.released}` : ''}</span></h2>
          <p className="setprogress">
            <meter min={0} max={s.cards} value={s.owned} aria-label={`${pct(s.owned, s.cards)}% of the set owned`} />
            {' '}<strong>{s.owned.toLocaleString()}</strong> of {s.cards.toLocaleString()} cards ({pct(s.owned, s.cards)}%)
            {s.ownedHere > 0 && <span className="muted small"> · {s.ownedHere.toLocaleString()} recorded as this set's printing</span>}
          </p>
          {detail.missingUsd !== null && s.owned < s.cards && (
            <p className="statline">About <strong>{usd(detail.missingUsd)}</strong> to buy the rest, each at its cheapest price in this set{detail.unpriced > 0 && <span className="muted small"> ({detail.unpriced} with no price)</span>}. <span className="muted small">Scryfall's prices: a rough guide.</span></p>
          )}
          <div className="deckbar">
            <span className="seg" role="group" aria-label="Which cards">
              {(['all', 'owned', 'missing'] as const).map((f) => <button key={f} className={filter === f ? 'active' : ''} aria-pressed={filter === f} onClick={() => { setFilter(f); setLimit(PAGE); }}>{f === 'all' ? 'All' : f === 'owned' ? 'Owned' : 'Missing'}</button>)}
            </span>
            <button onClick={() => onSearch(s.code)}>Search this set in Cards</button>
          </div>
          {detail.cards.length === 0 && <p className="muted">{filter === 'owned' ? "You don't own any cards from this set yet." : filter === 'missing' ? 'You own every card in this set. 🎉' : 'Nothing here.'}</p>}
          <div className="grid">{detail.cards.map((c) => <SetTile key={c.printingId} c={c} onOpenCard={onOpenCard} onCopies={setCopies} />)}</div>
          {detail.total > detail.cards.length && <p><button onClick={() => setLimit((l) => l + PAGE)}>Show more ({(detail.total - detail.cards.length).toLocaleString()} left)</button></p>}
        </>
      )}
    </section>
  );
}

/** Browse sets, and for each one see which cards you own and what the rest would cost. Counting is by card: any printing you own counts. */
export function SetsView({ onOpenCard, onSearchSet, onCollectionChanged, collectionVersion }: { onOpenCard: (id: string) => void; onSearchSet: (code: string) => void; onCollectionChanged: () => void; collectionVersion: number }) {
  const [code, setCode] = useState<string | null>(null);
  return (
    <div className="sets">
      {code
        ? <SetPage code={code} onBack={() => setCode(null)} onOpenCard={onOpenCard} onSearch={onSearchSet} onCollectionChanged={onCollectionChanged} version={collectionVersion} />
        : <SetList onOpen={setCode} />}
    </div>
  );
}
