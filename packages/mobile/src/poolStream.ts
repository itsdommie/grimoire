/** Write a byte stream into a database file in the SQLite WASM file pool as it arrives, so a 100 MB file is never held in memory. */
export async function streamIntoPool(
  pool: { importDb(name: string, data: () => Promise<Uint8Array | undefined>): Promise<number> },
  name: string,
  stream: ReadableStream<Uint8Array>,
): Promise<number> {
  const reader = stream.getReader();
  let held = new Uint8Array(0);
  return pool.importDb(name, async () => {
    // The first chunk must hold the database header, so gather at least a page before handing anything over.
    while (held.length < 4096) {
      const { done, value } = await reader.read();
      if (done) break;
      const next = new Uint8Array(held.length + value.length);
      next.set(held); next.set(value, held.length);
      held = next;
    }
    if (held.length === 0) return undefined;
    const chunk = held;
    held = new Uint8Array(0);
    return chunk;
  });
}
