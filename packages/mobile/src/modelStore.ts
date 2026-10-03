/** Where the downloaded language model is kept on the phone. (An interface so tests can use memory; the app uses the browser's Cache API.) */
export interface ModelStore {
  get(name: string): Promise<Uint8Array | null>;
  put(name: string, bytes: Uint8Array): Promise<void>;
  clear(): Promise<void>;
}

const CACHE = 'grimoire-model';
const key = (name: string) => new Request(`https://model.grimoire.invalid/${name}`);

/** The Cache API is private to the app, works in a worker, and hands back the exact bytes stored. */
export const cacheStore: ModelStore = {
  async get(name) {
    const hit = await (await caches.open(CACHE)).match(key(name));
    return hit ? new Uint8Array(await hit.arrayBuffer()) : null;
  },
  async put(name, bytes) { await (await caches.open(CACHE)).put(key(name), new Response(bytes as BodyInit)); },
  async clear() { await caches.delete(CACHE); },
};

export function memoryStore(): ModelStore & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return { files, get: async (n) => files.get(n) ?? null, put: async (n, b) => { files.set(n, b); }, clear: async () => { files.clear(); } };
}
