import { useEffect, useMemo, useRef, useState } from 'react';
import { toSimDeck, type DeckEntry, type SimResult } from '@grimoire/shared';
import { ColumnChart, LineChart } from './charts';
import type { WorkerResponse } from './sim.worker';

const pct = (v: number) => `${Math.round(v * 100)}%`;
const GAME_CHOICES = [2_000, 10_000, 50_000];

export function SimulateView({ entries }: { entries: DeckEntry[] }) {
  const [games, setGames] = useState(10_000);
  const [onThePlay, setOnThePlay] = useState(false);
  const [mulligan, setMulligan] = useState(true);
  const [result, setResult] = useState<SimResult | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [ranFor, setRanFor] = useState<string>('');
  const workerRef = useRef<Worker | null>(null);

  const library = entries.filter((e) => e.board === 'main').reduce((n, e) => n + e.qty, 0);
  // Identifies the deck contents so we can tell when shown results no longer match.
  const deckKey = useMemo(() => entries.filter((e) => e.board !== 'sideboard').map((e) => `${e.card.id}:${e.qty}:${e.board}`).sort().join('|'), [entries]);
  const running = progress !== null;
  const stale = result !== null && ranFor !== deckKey;

  useEffect(() => () => workerRef.current?.terminate(), []);

  const run = () => {
    workerRef.current?.terminate();
    const worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    setProgress({ done: 0, total: games });
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      if (e.data.type === 'progress') { setProgress({ done: e.data.done, total: e.data.total }); setResult(e.data.partial); }
      else { setResult(e.data.result); setRanFor(deckKey); setProgress(null); worker.terminate(); workerRef.current = null; }
    };
    worker.postMessage({ type: 'run', deck: toSimDeck(entries), options: { games, turns: 10, seed: Math.floor(Math.random() * 2 ** 31), onThePlay, mulligan: mulligan ? 'standard' : 'none' } });
  };
  const cancel = () => { workerRef.current?.terminate(); workerRef.current = null; setProgress(null); };

  if (library === 0) return <p className="empty">Add cards to simulate.</p>;
  const hasCommander = entries.some((e) => e.board === 'commander');
  const r = result;

  return (
    <div className="analysis">
      <section>
        <h3>Goldfish simulation</h3>
        <p className="muted small">Plays your deck alone, many times, to measure how reliably it develops mana. It doesn't model opponents or most card effects.</p>
        <div className="deckbar">
          <label>Games <select value={games} onChange={(e) => setGames(Number(e.target.value))} disabled={running}>{GAME_CHOICES.map((g) => <option key={g} value={g}>{g.toLocaleString()}</option>)}</select></label>
          <label><input type="checkbox" checked={onThePlay} onChange={(e) => setOnThePlay(e.target.checked)} disabled={running} /> On the play</label>
          <label><input type="checkbox" checked={mulligan} onChange={(e) => setMulligan(e.target.checked)} disabled={running} /> Mulligans</label>
        </div>
        <div className="deckbar">
          {running ? <button onClick={cancel}>Cancel</button> : <button className="primary" onClick={run}>{r ? 'Run again' : 'Run simulation'}</button>}
          {progress && <progress value={progress.done} max={progress.total} aria-label="Simulation progress" />}
          {progress && <span className="muted small">{progress.done.toLocaleString()} / {progress.total.toLocaleString()}</span>}
        </div>
        {library < 98 && <p className="muted small">The library has {library} cards, not 99, so land and draw odds will look different from the finished deck.</p>}
        {!hasCommander && <p className="muted small">No commander set, so commander timing isn't measured.</p>}
        {stale && !running && <p className="finding warn"><span className="ficon" aria-hidden>▲</span><span>The deck changed since this run. Run again for current numbers.</span></p>}
      </section>

      {r && (
        <>
          <section>
            <h3>Opening hands</h3>
            <p className="statline">
              <strong>{pct(r.opening.firstSevenKeepRate)}</strong> of opening 7s are keepable · <strong>{r.opening.avgMulligans.toFixed(2)}</strong> mulligans on average · <strong>{r.opening.avgKeptLands.toFixed(1)}</strong> lands in the kept hand
            </p>
            <ColumnChart
              title="Lands in the first seven cards" subtitle="before any mulligan"
              data={r.opening.landsDist.map((v, i) => ({ label: i === 7 ? '7' : String(i), value: v, detail: `${pct(v)} of opening hands have ${i} land${i === 1 ? '' : 's'}` }))}
              format={pct} unit="Lands"
            />
          </section>

          <section>
            <h3>Mana development</h3>
            <LineChart
              title="Land drops, mana and colour trouble by turn"
              series={[
                { name: 'Every land drop hit', values: r.perTurn.map((t) => t.landDrop) },
                { name: 'Mana ≥ turn number', values: r.perTurn.map((t) => t.onCurve) },
                { name: 'Colour-screwed so far', values: r.perTurn.map((t) => t.colorScrewEver) },
              ]}
            />
            <p className="muted small">
              Average turn you reach 4 mana: {r.turnToMana[4]?.avgTurn?.toFixed(1) ?? '–'} · 5 mana: {r.turnToMana[5]?.avgTurn?.toFixed(1) ?? '–'} · 6 mana: {r.turnToMana[6]?.avgTurn?.toFixed(1) ?? '–'}.
              "Colour-screwed" means a card in hand (or the commander) was affordable by mana count but not by colour.
            </p>
          </section>

          {r.commanders.length > 0 && (
            <section>
              <h3>Commander</h3>
              <LineChart
                title={r.commanders.length > 1 ? 'Commanders castable by turn' : `${r.commanders[0]} castable by turn`}
                series={r.commanders.map((name, i) => ({ name, values: r.perTurn.map((t) => t.commanderCast[i]!) }))}
              />
              <p className="statline">{r.commanders.map((n, i) => `${n}: ${r.commanderMedianTurn[i] ? `cast by turn ${r.commanderMedianTurn[i]} in half of games` : 'under half of games within 10 turns'}`).join(' · ')}</p>
            </section>
          )}

          <section>
            <h3>By turn</h3>
            <table className="data-table">
              <thead><tr><th>Turn</th><th className="num">Lands</th><th className="num">Mana</th><th className="num">Land drops</th><th className="num">Colour</th></tr></thead>
              <tbody>{r.perTurn.map((t) => <tr key={t.turn}><td>{t.turn}</td><td className="num">{t.avgLands.toFixed(1)}</td><td className="num">{t.avgMana.toFixed(1)}</td><td className="num">{pct(t.landDrop)}</td><td className="num">{pct(t.colorScrew)}</td></tr>)}</tbody>
            </table>
            <p className="muted small">Colour = share of games stuck on colour that turn. Based on {r.games.toLocaleString()} games.</p>
          </section>

          <details className="assumptions">
            <summary>How the simulated player behaves</summary>
            <ul className="small">
              <li>London mulligan with a free first mulligan. Keeps 7 cards with 2–5 lands (2–4 for smaller hands).</li>
              <li>Each turn: draw {onThePlay ? '(none on turn 1)' : '(including turn 1, as in multiplayer)'}, play a land (preferring colours the hand needs, then untapped lands), then cast the commander if it can, otherwise the cheapest ramp spell, otherwise the cheapest card-draw spell.</li>
              <li>Mana rocks work immediately, mana creatures after a turn. Land-search ramp puts lands onto the battlefield tapped. Lands that enter tapped only if you fail a condition are treated as untapped.</li>
              <li>Commander tax, recasts, X spells and every other card effect are ignored.</li>
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
