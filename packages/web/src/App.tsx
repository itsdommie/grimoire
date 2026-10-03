import { useCallback, useEffect, useMemo, useState } from 'react';
import { FORMATS, type Board, type Card, type CollectionSummary, type DeckDetail, type DeckSummary, type FormatId, type SearchResponse } from '@grimoire/shared';
import { api } from './api';
import { DeckPanel } from './DeckPanel';
import { DataFooter, DataSetup, PricesFooter, useDataStatus } from './DataSetup';
import { CollectionBar, CollectionImportDialog, CommanderIdeas, SkipUsedToggle } from './CollectionView';
import { CardDetailDialog } from './CardDetail';
import { BackupControls } from './Backup';
import { PlayView } from './PlayView';
import { RulesView } from './RulesView';
import { SemanticFooter, useSemanticStatus } from './Semantic';
import { Scanner } from './Scanner';

const ORDERS = [
  ['name', 'Name'],
  ['edhrec', 'EDHREC popularity'],
  ['cmc', 'Mana value'],
  ['usd', 'Price'],
] as const;

const EXAMPLES = ['t:creature c:rg cmc<=3 o:"draw a card"', 'f:commander id<=wubg is:commander', 'otag:ramp c:g cmc<=3', 'otag:sweeper f:commander', 'kw:flying r:mythic'];

function useSearch(query: string, order: string, version: string | null, scope: 'all' | 'collection', deck?: number) {
  const [state, setState] = useState<{ data: SearchResponse | null; loading: boolean }>({ data: null, loading: true });
  useEffect(() => {
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      api.search({ q: query, order, limit: 60, deck }, ctrl.signal, scope)
        .then((data) => { if (!ctrl.signal.aborted) setState({ data, loading: false }); })
        .catch((e) => { if (e.name !== 'AbortError' && !ctrl.signal.aborted) setState({ data: { total: 0, cards: [], error: 'Server unreachable' }, loading: false }); });
    }, 150);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [query, order, version, scope, deck]);
  /** A card changed in the detail dialog (its count, the printing you own): swap it into the visible results. */
  const patchCard = (card: Card) => setState((s) => (s.data ? { ...s, data: { ...s.data, cards: s.data.cards.map((c) => (c.id === card.id ? card : c)) } } : s));
  /** Reflect a collection edit in the visible results without refetching (cards owned 0 leave the collection view). */
  const patchOwned = (id: string, qty: number) => setState((s) => {
    if (!s.data) return s;
    const cards = s.data.cards.flatMap((c) => (c.id !== id ? [c] : scope === 'collection' && qty === 0 ? [] : [{ ...c, owned: qty }]));
    return { ...s, data: { ...s.data, cards, total: s.data.total - (s.data.cards.length - cards.length) } };
  });
  return { ...state, patchOwned, patchCard };
}

const LETTERS: Array<[number, string]> = [[1, 'w'], [2, 'u'], [4, 'b'], [8, 'r'], [16, 'g']];
const maskToLetters = (mask: number) => LETTERS.filter(([bit]) => mask & bit).map(([, l]) => l).join('') || 'c';

function CardTile({ card, inDeck, canAdd, commanderFormat, stepper, onAdd, onOwn, onOpen }: {
  card: Card; inDeck: number; canAdd: boolean; commanderFormat: boolean; stepper: boolean; onAdd: (card: Card, board: Board) => void; onOwn: (card: Card, qty: number) => void; onOpen: (id: string) => void;
}) {
  const owned = card.owned ?? 0;
  const inDecks = card.inDecks ?? 0;
  const spare = Math.max(0, owned - inDecks);
  return (
    <div className="tile" title={`${card.name}\n${card.typeLine}`}>
      <div className="art">
        <button className="imglink" onClick={() => onOpen(card.id)} aria-label={`Details for ${card.name}`}>
          {card.imageUrl ? <img src={card.imageUrl} alt="" loading="lazy" /> : <div className="noimg">{card.name}</div>}
        </button>
        {inDeck > 0 && <span className="badge">×{inDeck}</span>}
        {!stepper && owned > 0 && <span className="badge own" title={inDecks > 0 ? `${owned} in your collection, ${inDecks} in decks, ${spare} spare` : 'Copies in your collection'}>Own ×{owned}{inDecks > 0 && ` · ${inDecks} in decks`}</span>}
        <span className="overlay">
          {canAdd && <button onClick={() => onAdd(card, 'main')}>+ Deck</button>}
          {canAdd && (commanderFormat ? <button onClick={() => onAdd(card, 'commander')}>★ Cmdr</button> : <button onClick={() => onAdd(card, 'sideboard')}>+ Side</button>)}
          {!stepper && <button onClick={() => onOwn(card, owned + 1)} aria-label={`Add ${card.name} to collection`}>+ Own</button>}
        </span>
      </div>
      <span className="name">{card.name}</span>
      {card.ownedPrinting && <span className="printline" title="The printing you own">{card.ownedPrinting.set.toUpperCase()} #{card.ownedPrinting.collector}{card.ownedPrinting.finish === 'nonfoil' ? '' : ` · ${card.ownedPrinting.finish}`}</span>}
      {stepper && (
        <span className="stepper" role="group" aria-label={`Copies of ${card.name} owned`}>
          <button onClick={() => onOwn(card, owned - 1)} aria-label={`Own one fewer ${card.name}`}>−</button>
          <span>{owned}</span>
          <button onClick={() => onOwn(card, owned + 1)} aria-label={`Own one more ${card.name}`}>+</button>
          {inDecks > 0 && <span className="muted small" title="Copies sitting in your decks">{inDecks} in decks</span>}
        </span>
      )}
    </div>
  );
}

export function App() {
  const [query, setQuery] = useState('');
  const [order, setOrder] = useState<string>('edhrec');
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [current, setCurrent] = useState<DeckDetail | null>(null);
  const [onlyIdentity, setOnlyIdentity] = useState(true);
  const [onlyOwned, setOnlyOwned] = useState(false);
  // Whether to leave out copies that are already in decks when suggesting cards (remembered between sessions).
  const [skipUsed, setSkipUsedState] = useState(() => { try { return localStorage.getItem('grimoire.skipUsed') === '1'; } catch { return false; } });
  const setSkipUsed = (v: boolean) => { setSkipUsedState(v); try { localStorage.setItem('grimoire.skipUsed', v ? '1' : '0'); } catch { /* storage unavailable */ } };
  const [onlyLegal, setOnlyLegal] = useState(true);
  const [view, setView] = useState<'cards' | 'collection' | 'play' | 'rules'>('cards');
  // On a phone the browse area and the deck are separate full-screen panes; on a wide screen they sit side by side and this is unused.
  const [pane, setPane] = useState<'browse' | 'deck'>('browse');
  const [ruleToOpen, setRuleToOpen] = useState<string | null>(null);
  const [collection, setCollection] = useState<CollectionSummary | null>(null);
  const [collectionVersion, setCollectionVersion] = useState(0);
  const [importing, setImporting] = useState(false);
  const [scanning, setScanning] = useState(false);
  // Only the Android app has a text recognizer (ML Kit), so only it offers the scanner.
  const recognizer = typeof window !== 'undefined' ? window.grimoireNative?.textRecognition : undefined;
  const [detailId, setDetailId] = useState<string | null>(null);
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

  const rules = FORMATS[current?.deck.format ?? 'commander'];
  const commanderIdentity = useMemo(() => {
    const cmdrs = rules.commander ? current?.entries.filter((e) => e.board === 'commander') ?? [] : [];
    return onlyIdentity && cmdrs.length ? maskToLetters(cmdrs.reduce((m, e) => m | e.card.colorIdentity, 0)) : null;
  }, [current, onlyIdentity, rules.commander]);

  const dataStatus = useDataStatus();
  const semantic = useSemanticStatus();
  const searchQuery = view === 'cards'
    ? [query, commanderIdentity ? `f:commander id<=${commanderIdentity}` : '', current && !rules.commander && onlyLegal ? `f:${rules.legality}` : '', onlyOwned ? (skipUsed ? 'spare>0' : 'owned>0') : ''].filter(Boolean).join(' ')
    : query;
  const { data, loading, patchOwned, patchCard } = useSearch(searchQuery, order, dataStatus.status?.bulkUpdatedAt ?? null, view === 'collection' ? 'collection' : 'all', view === 'cards' && onlyOwned && skipUsed ? current?.deck.id : undefined);
  const inDeck = useMemo(() => new Map((current?.entries ?? []).map((e) => [e.card.id, e.qty])), [current]);

  const refreshCollection = useCallback(async () => { try { setCollection(await api.collectionSummary()); } catch { /* shown elsewhere */ } }, []);
  useEffect(() => { void refreshCollection(); }, [refreshCollection]);

  /** After any collection change: refresh the summary and the open deck (its owned counts), and tell dependent panels. */
  const collectionChanged = useCallback(async () => {
    await refreshCollection();
    setCollectionVersion((v) => v + 1);
    if (current) await open(current.deck.id);
  }, [refreshCollection, current, open]);

  const own = async (card: Card, qty: number) => {
    const next = Math.max(0, qty);
    try { setCollection(await api.setOwned(card.id, next)); patchOwned(card.id, next); setCollectionVersion((v) => v + 1); if (current) await open(current.deck.id); } catch (e) { setError((e as Error).message); }
  };
  const startDeck = async (commander: Card) => {
    try {
      const d = await api.createDeck(commander.name);
      await api.setCard(d.id, commander.id, 'commander', 1);
      await refreshDecks();
      await open(d.id);
      setView('cards');
    } catch (e) { setError((e as Error).message); }
  };

  const changed = (detail: DeckDetail) => { setCurrent(detail); setDecks((ds) => ds.map((d) => (d.id === detail.deck.id ? detail.deck : d))); };
  const add = async (card: Card, board: Board) => {
    if (!current) return;
    const existing = current.entries.find((e) => e.card.id === card.id);
    // Adding to the same board again bumps the quantity; commander is always exactly one.
    const qty = board === 'commander' ? 1 : existing && existing.board === board ? existing.qty + 1 : 1;
    try { changed(await api.setCard(current.deck.id, card.id, board, qty)); } catch (e) { setError((e as Error).message); }
  };

  const ds = dataStatus.status;
  // First run (or a failed first download): nothing to search yet, so show the setup screen instead of an empty app.
  if (!ds || (ds.cardCount === 0 && ds.state !== 'ready')) {
    if (!ds && !dataStatus.unreachable) return <div className="setup" aria-busy="true" />;
    return <DataSetup status={ds} unreachable={dataStatus.unreachable} onStart={() => dataStatus.start()} />;
  }

  return (
    <div className={`layout${view === 'play' || view === 'rules' ? ' noside' : ''}${pane === 'deck' ? ' show-deck' : ''}`}>
      <div className="browse">
        <header>
          <h1>Grimoire</h1>
          <nav className="viewtabs" aria-label="Views">
            <button className={view === 'cards' ? 'active' : ''} aria-current={view === 'cards' ? 'page' : undefined} onClick={() => setView('cards')}>Cards</button>
            <button className={view === 'collection' ? 'active' : ''} aria-current={view === 'collection' ? 'page' : undefined} onClick={() => setView('collection')}>Collection</button>
            <button className={view === 'rules' ? 'active' : ''} aria-current={view === 'rules' ? 'page' : undefined} onClick={() => setView('rules')}>Rules</button>
            <button className={view === 'play' ? 'active' : ''} aria-current={view === 'play' ? 'page' : undefined} onClick={() => setView('play')}>Play</button>
          </nav>
          {view !== 'play' && view !== 'rules' && <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={view === 'collection' ? 'Filter your collection: t:creature c:g' : 'Search: t:creature c:rg cmc<=3 o:"draw a card"'}
            spellCheck={false}
          />}
          {view !== 'play' && view !== 'rules' && recognizer && <button className="scanbtn" onClick={() => setScanning(true)} aria-label="Scan cards with the camera">Scan</button>}
          {view !== 'play' && view !== 'rules' && <select value={order} onChange={(e) => setOrder(e.target.value)} aria-label="Sort order">
            {ORDERS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>}
        </header>
        <main>
          {view === 'play' ? <PlayView /> : view === 'rules' ? <RulesView openRule={ruleToOpen} onRuleOpened={() => setRuleToOpen(null)} /> : (<>
          {error && <p className="error" role="alert">{error} <button onClick={() => setError(null)}>dismiss</button></p>}
          <p className="status">
            {data?.error ? <span className="error">{data.error}</span> : data ? `${data.total.toLocaleString()} cards${data.total > data.cards.length ? ` (showing ${data.cards.length})` : ''}${/\b(?:about|meaning|sem):/.test(searchQuery) ? ', best matches first' : ''}` : ''}
            {loading && ' …'}
            {view === 'cards' && current && !rules.commander && (
              <label className="filter"><input type="checkbox" checked={onlyLegal} onChange={(e) => setOnlyLegal(e.target.checked)} /> Only cards legal in {rules.name}</label>
            )}
            {view === 'cards' && current && rules.commander && current.entries.some((e) => e.board === 'commander') && (
              <label className="filter"><input type="checkbox" checked={onlyIdentity} onChange={(e) => setOnlyIdentity(e.target.checked)} /> Only Commander-legal cards in the commander's colours</label>
            )}
            {view === 'cards' && collection && collection.total > 0 && (
              <label className="filter"><input type="checkbox" checked={onlyOwned} onChange={(e) => setOnlyOwned(e.target.checked)} /> Only cards I own</label>
            )}
            {view === 'cards' && collection && collection.total > 0 && onlyOwned && <SkipUsedToggle checked={skipUsed} onChange={setSkipUsed} />}
          </p>
          {view === 'collection' && <CollectionBar cheapest={!!ds.prices?.enabled && !!ds.prices.updatedAt} summary={collection} onImport={() => setImporting(true)} onClear={async () => { try { await api.clearCollection(); await collectionChanged(); } catch (e) { setError((e as Error).message); } }} />}
          {view === 'collection' && <CommanderIdeas version={collectionVersion} skipUsed={skipUsed} onSkipUsed={setSkipUsed} onBuild={startDeck} />}
          {view === 'cards' && !query && (
            <p className="examples">Try: {(semantic.status?.state === 'ready' ? [...EXAMPLES, 'about:"punish opponents for drawing extra cards"'] : EXAMPLES).map((ex) => <button key={ex} onClick={() => setQuery(ex)}>{ex}</button>)}</p>
          )}
          {view === 'collection' && data && data.total === 0 && !query && collection?.total ? <p className="muted">Nothing matches.</p> : null}
          <div className="grid">{data?.cards.map((c) => <CardTile key={c.id} card={c} inDeck={inDeck.get(c.id) ?? 0} canAdd={!!current} commanderFormat={rules.commander} stepper={view === 'collection'} onAdd={add} onOwn={own} onOpen={setDetailId} />)}</div>
          </>)}
        </main>
        <footer>
          <p><DataFooter status={ds} onUpdate={() => dataStatus.start()} /></p>
          <p><PricesFooter status={ds} onEnable={() => void dataStatus.setPrices(true)} onDisable={() => void dataStatus.setPrices(false)} onRefresh={() => void dataStatus.setPrices(true, true)} /></p>
          <p><SemanticFooter status={semantic.status} onEnable={semantic.enable} onCancel={semantic.cancel} onRemove={semantic.remove} /></p>
          <p><BackupControls onError={setError} onRestored={async () => { const list = await api.listDecks(); setDecks(list); if (list[0]) await open(list[0].id); else setCurrent(null); await collectionChanged(); }} /></p>
          Card data and images from <a href="https://scryfall.com" target="_blank" rel="noreferrer">Scryfall</a>. Magic: The Gathering is © Wizards of the Coast.
          Grimoire is unofficial, non-commercial fan content and is not approved or endorsed by Wizards of the Coast.
        </footer>
      </div>
      {view !== 'play' && view !== 'rules' && <DeckPanel
        decks={decks}
        current={current}
        onSelect={open}
        onCreate={async (name, format: FormatId) => { try { const d = await api.createDeck(name, format); await refreshDecks(); await open(d.id); } catch (e) { setError((e as Error).message); } }}
        onDelete={async (id) => { try { await api.deleteDeck(id); const list = await api.listDecks(); setDecks(list); if (list[0]) await open(list[0].id); else setCurrent(null); } catch (e) { setError((e as Error).message); } }}
        onChange={changed}
        onDecksChanged={refreshDecks}
        onError={setError}
        collection={collection}
        collectionVersion={collectionVersion}
        onCollectionChanged={collectionChanged}
        skipUsed={skipUsed}
        onSkipUsed={setSkipUsed}
        onOpenCard={setDetailId}
        cheapest={!!ds.prices?.enabled && !!ds.prices.updatedAt}
      />}
      {view !== 'play' && view !== 'rules' && (
        <nav className="mobilebar" aria-label="Browse cards or open the deck">
          <button className={pane === 'browse' ? 'active' : ''} aria-pressed={pane === 'browse'} onClick={() => setPane('browse')}>Browse</button>
          <button className={pane === 'deck' ? 'active' : ''} aria-pressed={pane === 'deck'} onClick={() => setPane('deck')}>{current ? `Deck (${current.deck.cardCount})` : 'Deck'}</button>
        </nav>
      )}
      {detailId && (
        <CardDetailDialog
          cardId={detailId}
          canAddToDeck={!!current}
          commanderFormat={rules.commander}
          onClose={() => setDetailId(null)}
          onAddToDeck={(card, board) => void add(card, board)}
          onOwn={(card, qty) => void own(card, qty)}
          onCardChanged={(card) => { patchCard(card); void collectionChanged(); }}
          onSearchTag={(slug) => { setDetailId(null); setView('cards'); setQuery(`otag:${slug}`); }}
          onOpenRule={(id) => { setDetailId(null); setRuleToOpen(id); setView('rules'); }}
        />
      )}
      {scanning && recognizer && (
        <Scanner
          recognizer={recognizer}
          deck={current}
          onError={setError}
          onClose={() => { setScanning(false); void refreshDecks(); void collectionChanged(); }}
        />
      )}
      {importing && <CollectionImportDialog onClose={() => setImporting(false)} onDone={() => void collectionChanged()} onError={setError} />}
    </div>
  );
}
