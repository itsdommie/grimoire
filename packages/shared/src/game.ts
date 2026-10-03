// Life / commander-damage tracker state. A pure reducer with undo, so it's easy to test and the UI is a thin shell.

export type CounterKind = 'poison' | 'energy' | 'experience';
export const POISON_LETHAL = 10;
export const COMMANDER_DAMAGE_LETHAL = 21;

export interface Player {
  id: number;
  name: string;
  life: number;
  poison: number;
  energy: number;
  experience: number;
  /** Combat damage taken from each opposing commander, keyed by that player's id. */
  commanderDamage: Record<number, number>;
}

export interface GameState {
  players: Player[];
  startingLife: number;
  /** Player whose turn it is, or null before the game starts / after a reset. */
  activeId: number | null;
  /** 1-based round counter; increments when play passes from the last seat back to the first. */
  turn: number;
  monarchId: number | null;
  /** Commander damage is combat damage too, so by default it also lowers life. */
  commanderDamageReducesLife: boolean;
}

export type GameAction =
  | { type: 'new'; playerCount: number; startingLife: number; names?: string[]; commanderDamageReducesLife?: boolean }
  | { type: 'life'; id: number; delta: number }
  | { type: 'counter'; id: number; counter: CounterKind; delta: number }
  | { type: 'commander'; id: number; from: number; delta: number }
  | { type: 'rename'; id: number; name: string }
  | { type: 'next' }
  | { type: 'setActive'; id: number }
  | { type: 'monarch'; id: number | null };

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

export function newGame(playerCount = 4, startingLife = 40, names: string[] = [], commanderDamageReducesLife = true): GameState {
  const count = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, Math.floor(playerCount)));
  const players: Player[] = Array.from({ length: count }, (_, i) => ({
    id: i + 1, name: names[i]?.trim() || `Player ${i + 1}`, life: startingLife, poison: 0, energy: 0, experience: 0, commanderDamage: {},
  }));
  return { players, startingLife, activeId: players[0]!.id, turn: 1, monarchId: null, commanderDamageReducesLife };
}

export type OutReason = 'life' | 'poison' | 'commander';
/** Why a player has lost, if they have (state-based actions: 0 or less life, 10 poison, 21 damage from one commander). */
export function outReasons(p: Player): OutReason[] {
  const reasons: OutReason[] = [];
  if (p.life <= 0) reasons.push('life');
  if (p.poison >= POISON_LETHAL) reasons.push('poison');
  if (Object.values(p.commanderDamage).some((d) => d >= COMMANDER_DAMAGE_LETHAL)) reasons.push('commander');
  return reasons;
}
export const isOut = (p: Player) => outReasons(p).length > 0;

/** The only player left standing, if everyone else is out. */
export function winner(state: GameState): Player | null {
  const alive = state.players.filter((p) => !isOut(p));
  return state.players.length >= 2 && alive.length === 1 ? alive[0]! : null;
}

const LIFE_BOUND = 9999;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const mapPlayer = (state: GameState, id: number, fn: (p: Player) => Player): GameState =>
  ({ ...state, players: state.players.map((p) => (p.id === id ? fn(p) : p)) });

export function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case 'new':
      return newGame(action.playerCount, action.startingLife, action.names, action.commanderDamageReducesLife ?? state.commanderDamageReducesLife);
    case 'life':
      return mapPlayer(state, action.id, (p) => ({ ...p, life: clamp(p.life + action.delta, -LIFE_BOUND, LIFE_BOUND) }));
    case 'counter':
      return mapPlayer(state, action.id, (p) => ({ ...p, [action.counter]: clamp(p[action.counter] + action.delta, 0, 999) }));
    case 'commander': {
      if (action.id === action.from) return state;
      const target = state.players.find((p) => p.id === action.id);
      if (!target) return state;
      const before = target.commanderDamage[action.from] ?? 0;
      const after = clamp(before + action.delta, 0, 999);
      const applied = after - before; // clamped, so undoing past zero doesn't hand out free life
      if (applied === 0) return state;
      return mapPlayer(state, action.id, (p) => ({
        ...p,
        commanderDamage: { ...p.commanderDamage, [action.from]: after },
        life: state.commanderDamageReducesLife ? clamp(p.life - applied, -LIFE_BOUND, LIFE_BOUND) : p.life,
      }));
    }
    case 'rename':
      return mapPlayer(state, action.id, (p) => ({ ...p, name: action.name.slice(0, 40) }));
    case 'monarch':
      return { ...state, monarchId: action.id };
    case 'setActive':
      return state.players.some((p) => p.id === action.id) ? { ...state, activeId: action.id } : state;
    case 'next': {
      const alive = state.players.filter((p) => !isOut(p));
      if (alive.length === 0) return state;
      const seats = state.players;
      const from = Math.max(0, seats.findIndex((p) => p.id === state.activeId));
      // Walk clockwise to the next player who is still in the game.
      for (let step = 1; step <= seats.length; step++) {
        const idx = (from + step) % seats.length;
        if (!isOut(seats[idx]!)) {
          const wrapped = idx <= from; // passed the last seat (or came back to the same one)
          return { ...state, activeId: seats[idx]!.id, turn: wrapped ? state.turn + 1 : state.turn };
        }
      }
      return state;
    }
  }
}

// ------------------------------------------------------------------- undo

export interface GameHistory { present: GameState; past: GameState[] }
export const HISTORY_LIMIT = 200;

/** Actions that are edits of text/focus rather than game events don't get an undo step. */
const NO_UNDO: ReadonlySet<GameAction['type']> = new Set(['rename', 'setActive']);

export type HistoryAction = GameAction | { type: 'undo' };

export function historyReducer(h: GameHistory, action: HistoryAction): GameHistory {
  if (action.type === 'undo') {
    const previous = h.past[h.past.length - 1];
    return previous ? { present: previous, past: h.past.slice(0, -1) } : h;
  }
  const next = gameReducer(h.present, action);
  if (next === h.present) return h;
  if (NO_UNDO.has(action.type)) return { present: next, past: h.past };
  return { present: next, past: [...h.past, h.present].slice(-HISTORY_LIMIT) };
}

// ------------------------------------------------------------------- dice

/** Unbiased integer in [1, sides] from a source of random 32-bit unsigned integers (rejection sampling avoids modulo bias). */
export function rollDie(sides: number, random32: () => number): number {
  if (!Number.isInteger(sides) || sides < 2) throw new RangeError('A die needs at least 2 sides');
  const range = 2 ** 32;
  const limit = range - (range % sides);
  let r = random32();
  while (r >= limit) r = random32();
  return (r % sides) + 1;
}
