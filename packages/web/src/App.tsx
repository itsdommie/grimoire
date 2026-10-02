import { useEffect, useState } from 'react';
import type { Card, SearchResponse } from '@grimoire/shared';

const ORDERS = [
  ['name', 'Name'],
  ['edhrec', 'EDHREC popularity'],
  ['cmc', 'Mana value'],
  ['usd', 'Price'],
] as const;

const EXAMPLES = ['t:creature c:rg cmc<=3 o:"draw a card"', 'f:commander id<=wubg is:commander', 'o:"create a treasure" -c:w', 'kw:flying r:mythic'];

function useSearch(query: string, order: string) {
  const [state, setState] = useState<{ data: SearchResponse | null; loading: boolean }>({ data: null, loading: true });
  useEffect(() => {
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: query, order, limit: '60' });
      fetch(`/api/cards/search?${params}`, { signal: ctrl.signal })
        .then((r) => r.json() as Promise<SearchResponse>)
        .then((data) => setState({ data, loading: false }))
        .catch((e) => { if (e.name !== 'AbortError') setState({ data: { total: 0, cards: [], error: 'Server unreachable' }, loading: false }); });
    }, 150);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [query, order]);
  return state;
}

function CardTile({ card }: { card: Card }) {
  return (
    <a className="tile" href={card.scryfallUri} target="_blank" rel="noreferrer" title={`${card.name}\n${card.typeLine}`}>
      {card.imageUrl ? <img src={card.imageUrl} alt={card.name} loading="lazy" /> : <div className="noimg">{card.name}</div>}
      <span className="name">{card.name}</span>
    </a>
  );
}

export function App() {
  const [query, setQuery] = useState('');
  const [order, setOrder] = useState<string>('edhrec');
  const { data, loading } = useSearch(query, order);

  return (
    <>
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
        <p className="status">
          {data?.error ? <span className="error">{data.error}</span> : data ? `${data.total.toLocaleString()} cards${data.total > data.cards.length ? ` (showing ${data.cards.length})` : ''}` : ''}
          {loading && ' …'}
        </p>
        {!query && (
          <p className="examples">Try: {EXAMPLES.map((ex) => <button key={ex} onClick={() => setQuery(ex)}>{ex}</button>)}</p>
        )}
        <div className="grid">{data?.cards.map((c) => <CardTile key={c.id} card={c} />)}</div>
      </main>
      <footer>
        Card data and images from <a href="https://scryfall.com" target="_blank" rel="noreferrer">Scryfall</a>. Magic: The Gathering is © Wizards of the Coast.
        Grimoire is unofficial, non-commercial fan content and is not approved or endorsed by Wizards of the Coast.
      </footer>
    </>
  );
}
