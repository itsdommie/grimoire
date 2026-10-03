import { gunzipSync, gzipSync } from 'node:zlib';
import { ID_LEN, MAGIC, MAX_RAW_INDEX, UUID, decodeIndexRaw, type IndexRow } from './semantic-index-format.js';

// A pre-built semantic index: the int8 embedding of every card, computed in CI and published as a release asset, so a new install
// can download ~12 MB instead of spending minutes embedding 35,000 cards. Rows are keyed by a hash of the exact text that was
// embedded, so the app only uses a row when its own copy of the card text is identical.

export { PREBUILT_BASE, PREBUILT_MANIFEST, decodeIndexRaw, type IndexRow, type PrebuiltManifest } from './semantic-index-format.js';

/** Layout (before gzip): "GSI1", u32 dims, u32 count, u8 model-id length, model id, then per card: 36-byte id, u32 hash, dims int8 values. */
export function encodeIndex(rows: readonly IndexRow[], model: string, dims: number): Buffer {
  const modelBytes = Buffer.from(model, 'utf8');
  if (modelBytes.length > 255) throw new Error('Model id too long');
  const head = Buffer.alloc(4 + 4 + 4 + 1 + modelBytes.length);
  head.write(MAGIC, 0, 'ascii');
  head.writeUInt32LE(dims, 4);
  head.writeUInt32LE(rows.length, 8);
  head.writeUInt8(modelBytes.length, 12);
  modelBytes.copy(head, 13);
  const body = Buffer.alloc(rows.length * (ID_LEN + 4 + dims));
  rows.forEach((r, i) => {
    if (!UUID.test(r.id)) throw new Error(`Not a UUID: ${r.id}`);
    if (r.vec.length !== dims) throw new Error(`Vector for ${r.id} has ${r.vec.length} values, expected ${dims}`);
    const at = i * (ID_LEN + 4 + dims);
    body.write(r.id, at, 'ascii');
    body.writeUInt32LE(r.hash >>> 0, at + ID_LEN);
    Buffer.from(r.vec.buffer, r.vec.byteOffset, dims).copy(body, at + ID_LEN + 4);
  });
  return gzipSync(Buffer.concat([head, body]), { level: 9 });
}

/** Parse and validate a downloaded (gzipped) index. */
export function decodeIndex(gz: Buffer, expected: { model: string; dims: number }): IndexRow[] {
  return decodeIndexRaw(gunzipSync(gz, { maxOutputLength: MAX_RAW_INDEX }), expected);
}
