import { gunzipSync, gzipSync } from 'node:zlib';

// A pre-built semantic index: the int8 embedding of every card, computed in CI and published as a release asset, so a new install
// can download ~12 MB instead of spending minutes embedding 35,000 cards. Rows are keyed by a hash of the exact text that was
// embedded, so the app only uses a row when its own copy of the card text is identical.

export const PREBUILT_BASE = 'https://github.com/itsdommie/grimoire/releases/download/semantic-index';
export const PREBUILT_MANIFEST = 'semantic-index.json';

export interface PrebuiltManifest {
  format: 1;
  model: string;
  dims: number;
  count: number;
  createdAt: string;
  /** Asset file name, relative to the manifest. */
  file: string;
  /** SHA-256 and size of the (compressed) asset file. */
  sha256: string;
  size: number;
}

export interface IndexRow { id: string; hash: number; vec: Uint8Array }

const MAGIC = 'GSI1';
const ID_LEN = 36; // oracle ids are UUIDs
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

/** Parse and validate a downloaded index. Anything inconsistent is rejected: a bad file must never poison the local index. */
export function decodeIndex(gz: Buffer, expected: { model: string; dims: number }): IndexRow[] {
  const raw = gunzipSync(gz, { maxOutputLength: 200 * 1024 * 1024 });
  if (raw.length < 13 || raw.toString('ascii', 0, 4) !== MAGIC) throw new Error('Not a Grimoire semantic index');
  const dims = raw.readUInt32LE(4);
  const count = raw.readUInt32LE(8);
  const modelLen = raw.readUInt8(12);
  const model = raw.toString('utf8', 13, 13 + modelLen);
  if (model !== expected.model) throw new Error(`Index is for model ${model}, not ${expected.model}`);
  if (dims !== expected.dims) throw new Error(`Index has ${dims} dimensions, expected ${expected.dims}`);
  const start = 13 + modelLen;
  const stride = ID_LEN + 4 + dims;
  if (raw.length !== start + count * stride) throw new Error('Index file is truncated or has trailing data');
  const rows: IndexRow[] = [];
  for (let i = 0; i < count; i++) {
    const at = start + i * stride;
    const id = raw.toString('ascii', at, at + ID_LEN);
    if (!UUID.test(id)) throw new Error(`Index row ${i} has an invalid id`);
    rows.push({ id, hash: raw.readUInt32LE(at + ID_LEN), vec: new Uint8Array(raw.buffer.slice(raw.byteOffset + at + ID_LEN + 4, raw.byteOffset + at + stride)) });
  }
  return rows;
}
