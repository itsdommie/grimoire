import { describe, expect, it } from 'vitest';
import { COMMANDER_DAMAGE_LETHAL, gameReducer, historyReducer, isOut, newGame, outReasons, rollDie, winner, type GameAction, type GameHistory, type GameState } from './game.js';

const run = (s: GameState, ...actions: GameAction[]) => actions.reduce(gameReducer, s);
const player = (s: GameState, id: number) => s.players.find((p) => p.id === id)!;

describe('newGame', () => {
  it('seats the requested players with starting life and clamps the count', () => {
    const g = newGame(4, 40, ['Ann', ' ', 'Cy']);
    expect(g.players.map((p) => [p.id, p.name, p.life])).toEqual([[1, 'Ann', 40], [2, 'Player 2', 40], [3, 'Cy', 40], [4, 'Player 4', 40]]);
    expect(g).toMatchObject({ activeId: 1, turn: 1, monarchId: null, startingLife: 40, commanderDamageReducesLife: true });
    expect(newGame(1).players).toHaveLength(2);
    expect(newGame(99).players).toHaveLength(6);
  });
});

describe('life and counters', () => {
  it('changes life (including below zero) and clamps counters at zero', () => {
    const g = run(newGame(2, 20), { type: 'life', id: 1, delta: -25 }, { type: 'life', id: 2, delta: 5 }, { type: 'counter', id: 1, counter: 'poison', delta: 3 }, { type: 'counter', id: 1, counter: 'poison', delta: -9 }, { type: 'counter', id: 2, counter: 'energy', delta: 4 });
    expect(player(g, 1)).toMatchObject({ life: -5, poison: 0 });
    expect(player(g, 2)).toMatchObject({ life: 25, energy: 4 });
  });
  it('is immutable', () => {
    const g = newGame(2, 20);
    const before = JSON.stringify(g);
    gameReducer(g, { type: 'life', id: 1, delta: -3 });
    expect(JSON.stringify(g)).toBe(before);
  });
});

describe('elimination', () => {
  it('reports life, poison and commander damage separately', () => {
    let g = newGame(3, 40);
    g = run(g, { type: 'life', id: 1, delta: -40 }, { type: 'counter', id: 2, counter: 'poison', delta: 10 });
    expect(outReasons(player(g, 1))).toEqual(['life']);
    expect(outReasons(player(g, 2))).toEqual(['poison']);
    g = run(g, { type: 'commander', id: 3, from: 1, delta: COMMANDER_DAMAGE_LETHAL });
    expect(outReasons(player(g, 3))).toEqual(['commander']);
    expect(isOut(player(newGame(2), 1))).toBe(false);
  });
  it('commander damage is tracked per source: 20 from two commanders is not lethal', () => {
    const g = run(newGame(3, 100), { type: 'commander', id: 1, from: 2, delta: 20 }, { type: 'commander', id: 1, from: 3, delta: 20 });
    expect(outReasons(player(g, 1))).toEqual([]);
  });
  it('names the winner when one player is left', () => {
    let g = newGame(3, 40);
    expect(winner(g)).toBeNull();
    g = run(g, { type: 'life', id: 1, delta: -40 }, { type: 'life', id: 2, delta: -40 });
    expect(winner(g)?.id).toBe(3);
    expect(winner(run(g, { type: 'life', id: 3, delta: -40 }))).toBeNull(); // nobody left
  });
});

describe('commander damage', () => {
  it('also lowers life by default, and undoing it gives the life back', () => {
    let g = run(newGame(2, 40), { type: 'commander', id: 1, from: 2, delta: 7 });
    expect(player(g, 1)).toMatchObject({ life: 33, commanderDamage: { 2: 7 } });
    g = run(g, { type: 'commander', id: 1, from: 2, delta: -3 });
    expect(player(g, 1)).toMatchObject({ life: 36, commanderDamage: { 2: 4 } });
  });
  it('never goes below zero, and decrementing at zero does not grant life', () => {
    const g = run(newGame(2, 40), { type: 'commander', id: 1, from: 2, delta: -5 });
    expect(player(g, 1)).toMatchObject({ life: 40, commanderDamage: {} });
  });
  it('can be set to leave life alone; ignores self-damage and unknown players', () => {
    const g0 = gameReducer(newGame(2, 40), { type: 'new', playerCount: 2, startingLife: 40, commanderDamageReducesLife: false });
    const g = run(g0, { type: 'commander', id: 1, from: 2, delta: 5 }, { type: 'commander', id: 1, from: 1, delta: 5 }, { type: 'commander', id: 99, from: 1, delta: 5 });
    expect(player(g, 1)).toMatchObject({ life: 40, commanderDamage: { 2: 5 } });
  });
});

describe('turns', () => {
  it('advances clockwise and increments the round when wrapping', () => {
    let g = newGame(3, 40);
    g = run(g, { type: 'next' });
    expect([g.activeId, g.turn]).toEqual([2, 1]);
    g = run(g, { type: 'next' }, { type: 'next' });
    expect([g.activeId, g.turn]).toEqual([1, 2]);
  });
  it('skips eliminated players, including across the wrap', () => {
    let g = run(newGame(4, 40), { type: 'life', id: 2, delta: -40 }, { type: 'life', id: 4, delta: -40 });
    g = run(g, { type: 'next' });
    expect([g.activeId, g.turn]).toEqual([3, 1]);
    g = run(g, { type: 'next' });
    expect([g.activeId, g.turn]).toEqual([1, 2]);
  });
  it('setActive and monarch work; unknown ids are ignored', () => {
    const g = run(newGame(3, 40), { type: 'setActive', id: 3 }, { type: 'monarch', id: 2 });
    expect([g.activeId, g.monarchId]).toEqual([3, 2]);
    expect(run(g, { type: 'setActive', id: 42 }).activeId).toBe(3);
    expect(run(g, { type: 'monarch', id: null }).monarchId).toBeNull();
  });
  it('does nothing when everyone is out', () => {
    const g = run(newGame(2, 1), { type: 'life', id: 1, delta: -1 }, { type: 'life', id: 2, delta: -1 });
    expect(run(g, { type: 'next' })).toBe(g);
  });
});

describe('history (undo)', () => {
  const start = (): GameHistory => ({ present: newGame(2, 40), past: [] });
  it('undoes game events one at a time, in reverse', () => {
    let h = start();
    h = historyReducer(h, { type: 'life', id: 1, delta: -5 });
    h = historyReducer(h, { type: 'counter', id: 2, counter: 'poison', delta: 2 });
    h = historyReducer(h, { type: 'undo' });
    expect(player(h.present, 2).poison).toBe(0);
    expect(player(h.present, 1).life).toBe(35);
    h = historyReducer(h, { type: 'undo' });
    expect(player(h.present, 1).life).toBe(40);
    expect(historyReducer(h, { type: 'undo' })).toBe(h); // nothing left
  });
  it('does not record no-op actions, renames or focus changes', () => {
    let h = start();
    h = historyReducer(h, { type: 'rename', id: 1, name: 'Zed' });
    h = historyReducer(h, { type: 'setActive', id: 2 });
    h = historyReducer(h, { type: 'commander', id: 1, from: 1, delta: 1 });
    expect(h.past).toHaveLength(0);
    expect(player(h.present, 1).name).toBe('Zed');
  });
  it('caps the history', () => {
    let h = start();
    for (let i = 0; i < 300; i++) h = historyReducer(h, { type: 'life', id: 1, delta: 1 });
    expect(h.past.length).toBe(200);
  });
  it('a new game can be undone back to the previous one', () => {
    let h = historyReducer(start(), { type: 'life', id: 1, delta: -10 });
    h = historyReducer(h, { type: 'new', playerCount: 3, startingLife: 20 });
    expect(h.present.players).toHaveLength(3);
    h = historyReducer(h, { type: 'undo' });
    expect(player(h.present, 1).life).toBe(30);
  });
});

describe('rollDie', () => {
  it('maps random words into 1..sides without modulo bias', () => {
    expect(rollDie(6, () => 0)).toBe(1);
    expect(rollDie(6, () => 5)).toBe(6);
    // 2^32 is not a multiple of 6: values in the leftover tail are rejected and redrawn.
    const limit = 2 ** 32 - (2 ** 32 % 6);
    const seq = [limit, limit + 1, 7];
    expect(rollDie(6, () => seq.shift()!)).toBe((7 % 6) + 1);
  });
  it('is uniform over many rolls and rejects bad dice', () => {
    let state = 12345;
    const rng = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; }; // simple LCG, deterministic
    const counts = Array(21).fill(0);
    const N = 100_000;
    for (let i = 0; i < N; i++) counts[rollDie(20, rng)]++;
    expect(counts[0]).toBe(0);
    for (let face = 1; face <= 20; face++) expect(Math.abs(counts[face] / N - 0.05)).toBeLessThan(0.006);
    expect(() => rollDie(1, () => 0)).toThrow(RangeError);
    expect(() => rollDie(2.5, () => 0)).toThrow(RangeError);
  });
});
