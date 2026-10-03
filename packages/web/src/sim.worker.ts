import { Simulator, type SimDeck, type SimOptions, type SimResult } from '@grimoire/shared';

// Runs the goldfish simulation off the main thread, in chunks so a Cancel message can get through.
export type WorkerRequest = { type: 'run'; deck: SimDeck; options: SimOptions } | { type: 'cancel' };
export type WorkerResponse = { type: 'progress'; done: number; total: number; partial: SimResult } | { type: 'done'; result: SimResult };

const ctx = self as unknown as { postMessage(m: WorkerResponse): void; onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null };
let cancelled = false;
let running = false;

ctx.onmessage = async (e) => {
  if (e.data.type === 'cancel') { cancelled = true; return; }
  if (running) return;
  running = true;
  cancelled = false;
  const { deck, options } = e.data;
  const sim = new Simulator(deck, options);
  const CHUNK = 500;
  while (sim.gamesRun < options.games && !cancelled) {
    sim.run(Math.min(CHUNK, options.games - sim.gamesRun));
    if (sim.gamesRun < options.games) ctx.postMessage({ type: 'progress', done: sim.gamesRun, total: options.games, partial: sim.result() });
    await new Promise((r) => setTimeout(r, 0)); // let a cancel message arrive
  }
  if (!cancelled) ctx.postMessage({ type: 'done', result: sim.result() });
  running = false;
};
