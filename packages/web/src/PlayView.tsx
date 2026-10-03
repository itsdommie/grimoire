import { useEffect, useReducer, useState } from 'react';
import { useBack } from './backstack';
import {
  COMMANDER_DAMAGE_LETHAL, MAX_PLAYERS, MIN_PLAYERS, POISON_LETHAL, historyReducer, newGame, outReasons, rollDie, winner,
  type CounterKind, type GameHistory, type GameState, type OutReason, type Player,
} from '@grimoire/shared';

const STORAGE_KEY = 'grimoire.game';

function load(): GameHistory {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as GameHistory;
      if (Array.isArray(parsed.present?.players) && parsed.present.players.length >= MIN_PLAYERS && Array.isArray(parsed.past)) return parsed;
    }
  } catch { /* corrupt or unavailable storage: start fresh */ }
  return { present: newGame(4, 40), past: [] };
}

const random32 = () => crypto.getRandomValues(new Uint32Array(1))[0]!;
const REASON_TEXT: Record<OutReason, string> = { life: 'out of life', poison: 'poisoned', commander: 'commander damage' };

export function PlayView() {
  const [history, dispatch] = useReducer(historyReducer, undefined, load);
  const game = history.present;
  const [setup, setSetup] = useState(false);
  const [roll, setRoll] = useState<string>('');

  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(history)); } catch { /* storage unavailable */ } }, [history]);

  const active = game.players.find((p) => p.id === game.activeId);
  const won = winner(game);
  const doRoll = (label: string, sides: number) => setRoll(`${label}: ${rollDie(sides, random32)}`);

  return (
    <div className="play">
      <div className="playbar" role="toolbar" aria-label="Game controls">
        <span className="turninfo" aria-live="polite">
          {won ? <strong>{won.name} wins!</strong> : <>Turn <strong>{game.turn}</strong> · <strong>{active?.name ?? '–'}</strong>'s turn</>}
        </span>
        <button className="primary" onClick={() => dispatch({ type: 'next' })} disabled={!!won}>Next turn</button>
        <button onClick={() => dispatch({ type: 'undo' })} disabled={history.past.length === 0}>Undo</button>
        <span className="sep" aria-hidden />
        <button onClick={() => doRoll('d6', 6)}>d6</button>
        <button onClick={() => doRoll('d20', 20)}>d20</button>
        <button onClick={() => setRoll(`Coin: ${rollDie(2, random32) === 1 ? 'Heads' : 'Tails'}`)}>Coin</button>
        <button onClick={() => { const p = game.players[rollDie(game.players.length, random32) - 1]!; dispatch({ type: 'setActive', id: p.id }); setRoll(`${p.name} goes first`); }}>Random first player</button>
        <span className="rollresult" role="status" aria-live="polite">{roll}</span>
        <span className="grow" />
        <button onClick={() => setSetup(true)}>New game…</button>
      </div>

      <div className="players">
        {game.players.map((p) => (
          <PlayerCard key={p.id} game={game} p={p} dispatch={dispatch} />
        ))}
      </div>

      {setup && <NewGameDialog game={game} onClose={() => setSetup(false)} onStart={(a) => { dispatch({ type: 'new', ...a }); setSetup(false); setRoll(''); }} />}
    </div>
  );
}

type Dispatch = (a: Parameters<typeof historyReducer>[1]) => void;

function PlayerCard({ game, p, dispatch }: { game: GameState; p: Player; dispatch: Dispatch }) {
  const reasons = outReasons(p);
  const out = reasons.length > 0;
  const isActive = game.activeId === p.id;
  const others = game.players.filter((o) => o.id !== p.id);
  const life = (delta: number) => dispatch({ type: 'life', id: p.id, delta });
  const counter = (kind: CounterKind, delta: number) => dispatch({ type: 'counter', id: p.id, counter: kind, delta });

  return (
    <section className={`player${isActive ? ' active' : ''}${out ? ' out' : ''}`} aria-label={`${p.name}${isActive ? ', active player' : ''}${out ? `, eliminated: ${reasons.map((r) => REASON_TEXT[r]).join(', ')}` : ''}`} aria-current={isActive ? 'true' : undefined}>
      <header>
        <input className="pname" value={p.name} aria-label={`Name for player ${p.id}`} onChange={(e) => dispatch({ type: 'rename', id: p.id, name: e.target.value })} />
        <button className={game.monarchId === p.id ? 'toggle on' : 'toggle'} aria-pressed={game.monarchId === p.id} title="The monarch" onClick={() => dispatch({ type: 'monarch', id: game.monarchId === p.id ? null : p.id })}>Monarch</button>
        {!isActive && !out && <button className="toggle" onClick={() => dispatch({ type: 'setActive', id: p.id })} aria-label={`Make it ${p.name}'s turn`}>Their turn</button>}
      </header>

      <div className="lifeblock">
        <div className="lifebtns">
          <button onClick={() => life(-5)} aria-label={`${p.name} loses 5 life`}>−5</button>
          <button onClick={() => life(-1)} aria-label={`${p.name} loses 1 life`}>−1</button>
        </div>
        <div className="life" role="status" aria-live="polite" aria-label={`${p.name} has ${p.life} life`}>{p.life}</div>
        <div className="lifebtns">
          <button onClick={() => life(1)} aria-label={`${p.name} gains 1 life`}>+1</button>
          <button onClick={() => life(5)} aria-label={`${p.name} gains 5 life`}>+5</button>
        </div>
      </div>

      {out && <p className="outnote"><span aria-hidden>✗</span> Eliminated: {reasons.map((r) => REASON_TEXT[r]).join(', ')}</p>}

      <div className="counters">
        <Counter label="Poison" value={p.poison} warnAt={POISON_LETHAL - 3} onChange={(d) => counter('poison', d)} name={p.name} suffix={`/${POISON_LETHAL}`} />
        <Counter label="Energy" value={p.energy} onChange={(d) => counter('energy', d)} name={p.name} />
        <Counter label="Experience" value={p.experience} onChange={(d) => counter('experience', d)} name={p.name} />
      </div>

      <details className="cmdr">
        <summary>Commander damage taken {Object.values(p.commanderDamage).some((d) => d > 0) && <span className="muted small">(highest {Math.max(...Object.values(p.commanderDamage))}/{COMMANDER_DAMAGE_LETHAL})</span>}</summary>
        {others.map((o) => {
          const d = p.commanderDamage[o.id] ?? 0;
          return (
            <div className="cmdrrow" key={o.id}>
              <span className="cname">from {o.name}</span>
              <button onClick={() => dispatch({ type: 'commander', id: p.id, from: o.id, delta: -1 })} aria-label={`Remove 1 commander damage from ${o.name} to ${p.name}`}>−</button>
              <span className={d >= COMMANDER_DAMAGE_LETHAL ? 'cval lethal' : 'cval'}>{d}</span>
              <button onClick={() => dispatch({ type: 'commander', id: p.id, from: o.id, delta: 1 })} aria-label={`Add 1 commander damage from ${o.name} to ${p.name}`}>+</button>
            </div>
          );
        })}
      </details>
    </section>
  );
}

function Counter({ label, value, onChange, name, warnAt, suffix }: { label: string; value: number; onChange: (d: number) => void; name: string; warnAt?: number; suffix?: string }) {
  return (
    <div className="counter" role="group" aria-label={`${label} counters for ${name}`}>
      <span className="clabel">{label}</span>
      <button onClick={() => onChange(-1)} aria-label={`Remove one ${label.toLowerCase()} counter from ${name}`}>−</button>
      <span className={warnAt !== undefined && value >= warnAt ? 'cval warn' : 'cval'}>{value}{suffix && <small className="muted">{suffix}</small>}</span>
      <button onClick={() => onChange(1)} aria-label={`Add one ${label.toLowerCase()} counter to ${name}`}>+</button>
    </div>
  );
}

function NewGameDialog({ game, onClose, onStart }: { game: GameState; onClose: () => void; onStart: (a: { playerCount: number; startingLife: number; names: string[]; commanderDamageReducesLife: boolean }) => void }) {
  useBack(true, onClose);
  const [count, setCount] = useState(game.players.length);
  const [life, setLife] = useState(game.startingLife);
  const [reduces, setReduces] = useState(game.commanderDamageReducesLife);
  const [keepNames, setKeepNames] = useState(true);
  return (
    <div className="modal" role="dialog" aria-label="New game" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <form className="dialog narrow" onSubmit={(e) => { e.preventDefault(); onStart({ playerCount: count, startingLife: life, names: keepNames ? game.players.map((p) => p.name) : [], commanderDamageReducesLife: reduces }); }}>
        <h2>New game</h2>
        <label className="field">Players
          <select value={count} onChange={(e) => setCount(Number(e.target.value))}>{Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => MIN_PLAYERS + i).map((n) => <option key={n} value={n}>{n}</option>)}</select>
        </label>
        <label className="field">Starting life
          <select value={life} onChange={(e) => setLife(Number(e.target.value))}>{[20, 25, 30, 40, 50].map((n) => <option key={n} value={n}>{n}{n === 40 ? ' (Commander)' : n === 20 ? ' (Standard)' : ''}</option>)}</select>
        </label>
        <label className="check"><input type="checkbox" checked={reduces} onChange={(e) => setReduces(e.target.checked)} /> Commander damage also lowers life</label>
        <label className="check"><input type="checkbox" checked={keepNames} onChange={(e) => setKeepNames(e.target.checked)} /> Keep player names</label>
        <div className="deckbar end">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary">Start</button>
        </div>
      </form>
    </div>
  );
}
