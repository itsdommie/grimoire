import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Board, Card, DeckDetail, DeckSummary, SearchResponse } from '@grimoire/shared';
import { api } from './api';
import { DeckPanel } from './DeckPanel';
import { DataFooter, DataSetup, useDataStatus } from './DataSetup';

const ORDERS = [
  ['name', 'Name'],
  ['edhrec', 'EDHREC popularity'],
  ['cmc', 'Mana value'],
  ['usd', 'Price'],
] as const;

const EXAMPLES = ['t:creature c:rg cmc<=3 o:"draw a card"', 'f:commander id<=wubg is:commander', 'o:"create a treasure" -c:w', 'kw:flying r:mythic'];

function useSearch(query: string, order: string, commanderIdentity: string | null, version: string | null) {
  const [state, setState] = useState<{ data: SearchResponse | null; loading: boolean }>({ data: null, loading: true });
  const q = commanderIdentity ? `${query} f:commander id<=${commanderIdentity}` : query;
  useEffect(() => {
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      api.search({ q, order, limit: 60 }, ctrl.signal)
        .then((data) => setState({ data, loading: false }))
        .catch((e) => { if (e.name !== 'AbortError') setState({ data: { total: 0, cards: [], error: 'Server unreachable' }, loading: false }); });
    }, 150);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [q, order, version]);
  return state;
}

const LETTERS: Array<[number, string]> = [[1, 'w'], [2, 'u'], [4, 'b'], [8, 'r'], [16, 'g']];
const maskToLetters = (mask: number) => LETTERS.filter(([bit]) => mask & bit).map(([, l]) => l).join('') || 'c';

function CardTile({ card, inDeck, canAdd, onAdd }: { card: Card; inDeck: number; canAdd: boolean; onAdd: (card: Card, board: Board) => void }) {
  return (
    <div className="tile" title={`${card.name}\n${card.typeLine}`}>
      <div className="art">
        <a href={card.scryfallUri} target="_blank" rel="noreferrer">
          {card.imageUrl ? <img src={card.imageUrl} alt={card.name} loading="lazy" /> : <div className="noimg">{card.name}</div>}
        </a>
        {inDeck > 0 && <span className="badge">×{inDeck}</span>}
        {canAdd && (
          <span className="overlay">
            <button onClick={() => onAdd(card, 'main')}>+ Deck</button>
            <button onClick={() => onAdd(card, 'commander')}>★ Cmdr</button>
          </span>
        )}
      </div>
      <span className="name">{card.name}</span>
    </div>
  );
}

export function App() {
  const [query, setQuery] = useState('');
  const [order, setOrder] = useState<string>('edhrec');
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [current, setCurrent] = useState<DeckDetail | null>(null);
  const [onlyIdentity, setOnlyIdentity] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshDecks = useCallback(async () => { try { setDecks(await api.listDecks()); } catch { /* server down: search shows the error */ } }, []);
  const open = useCallback(async (id: number) => {
    try {
      setCurrent(await api.getDeck(id));
      try { localStorage.setItem('grimoire.deck', String(id)); } catch { /* storage unavailable */ }
    } catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => {
    (async () => {
      const list = await api.listDecks().catch(() => [] as DeckSummary[]);
      setDecks(list);
      let saved: number | null = null;
      try { saved = Number(localStorage.getItem('grimoire.deck')) || null; } catch { /* ignore */ }
      const first = list.find((d) => d.id === saved) ?? list[0];
      if (first) open(first.id);
    })();
  }, [open]);

  const commanderIdentity = useMemo(() => {
    const cmdrs = current?.entries.filter((e) => e.board === 'commander') ?? [];
    return onlyIdentity && cmdrs.length ? maskToLetters(cmdrs.reduce((m, e) => m | e.card.colorIdentity, 0)) : null;
  }, [current, onlyIdentity]);

  const dataStatus = useDataStatus();
  const { data, loading } = useSearch(query, order, commanderIdentity, dataStatus.status?.bulkUpdatedAt ?? null);
  const inDeck = useMemo(() => new Map((current?.entries ?? []).map((e) => [e.card.id, e.qty])), [current]);

  const changed = (detail: DeckDetail) => { setCurrent(detail); setDecks((ds) => ds.map((d) => (d.id === detail.deck.id ? detail.deck : d))); };
  const add = async (card: Card, board: Board) => {
    if (!current) return;
    const existing = current.entries.find((e) => e.card.id === card.id);
    // Adding to the main deck again bumps the quantity; commander is always exactly one.
    const qty = board === 'commander' ? 1 : existing && existing.board === 'main' ? existing.qty + 1 : 1;
    try { changed(await api.setCard(current.deck.id, card.id, board, qty)); } catch (e) { setError((e as Error).message); }
  };

  const ds = dataStatus.status;
  // First run (or a failed first download): nothing to search yet, so show the setup screen instead of an empty app.
  if (!ds || (ds.cardCount === 0 && ds.state !== 'ready')) {
    if (!ds && !dataStatus.unreachable) return <div className="setup" aria-busy="true" />;
    return <DataSetup status={ds} unreachable={dataStatus.unreachable} onStart={() => dataStatus.start()} />;
  }

  return (
    <div className="layout">
      <div className="browse">
        <header>
          <h1>Grimoire</h1>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='Search: t:creature c:rg cmc<=3 o:"draw a card"'
            spellCheck={false}
          />
          <select value={order} onChange={(e) => setOrder(e.target.value)} aria-label="Sort order">
            {ORDERS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        </header>
        <main>
          {error && <p className="error" role="alert">{error} <button onClick={() => setError(null)}>dismiss</button></p>}
          <p className="status">
            {data?.error ? <span className="error">{data.error}</span> : data ? `${data.total.toLocaleString()} cards${data.total > data.cards.length ? ` (showing ${data.cards.length})` : ''}` : ''}
            {loading && ' …'}
            {current && current.entries.some((e) => e.board === 'commander') && (
              <label className="filter"><input type="checkbox" checked={onlyIdentity} onChange={(e) => setOnlyIdentity(e.target.checked)} /> Only Commander-legal cards in the commander's colours</label>
            )}
          </p>
          {!query && (
            <p className="examples">Try: {EXAMPLES.map((ex) => <button key={ex} onClick={() => setQuery(ex)}>{ex}</button>)}</p>
          )}
          <div className="grid">{data?.cards.map((c) => <CardTile key={c.id} card={c} inDeck={inDeck.get(c.id) ?? 0} canAdd={!!current} onAdd={add} />)}</div>
        </main>
        <footer>
          <p><DataFooter status={ds} onUpdate={() => dataStatus.start()} /></p>
          Card data and images from <a href="https://scryfall.com" target="_blank" rel="noreferrer">Scryfall</a>. Magic: The Gathering is © Wizards of the Coast.
          Grimoire is unofficial, non-commercial fan content and is not approved or endorsed by Wizards of the Coast.
        </footer>
      </div>
      <DeckPanel
        decks={decks}
        current={current}
        onSelect={open}
        onCreate={async (name) => { try { const d = await api.createDeck(name); await refreshDecks(); await open(d.id); } catch (e) { setError((e as Error).message); } }}
        onDelete={async (id) => { try { await api.deleteDeck(id); const list = await api.listDecks(); setDecks(list); if (list[0]) await open(list[0].id); else setCurrent(null); } catch (e) { setError((e as Error).message); } }}
        onChange={changed}
        onDecksChanged={refreshDecks}
        onError={setError}
      />
    </div>
  );
}
