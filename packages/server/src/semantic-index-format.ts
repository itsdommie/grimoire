// The pre-built semantic index's file format, in its platform-neutral half (no node: imports): reading an already decompressed index.
// Writing, and gunzipping with Node's zlib, are in semantic-prebuilt.ts.

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

export const MAGIC = 'GSI1';
export const ID_LEN = 36; // oracle ids are UUIDs
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An index never legitimately decompresses to more than this (35k cards x 424 bytes is ~15 MB). */
export const MAX_RAW_INDEX = 200 * 1024 * 1024;

const ascii = (b: Uint8Array, from: number, to: number) => { let s = ''; for (let i = from; i < to; i++) s += String.fromCharCode(b[i]!); return s; };

/** Whether a downloaded manifest describes an index this app can use. */
export function manifestUsable(m: PrebuiltManifest, expected: { model: string; dims: number }): boolean {
  return m.format === 1 && m.model === expected.model && m.dims === expected.dims && !!m.file && /^[0-9a-f]{64}$/.test(m.sha256);
}

/** Parse and validate a decompressed index. Anything inconsistent is rejected: a bad file must never poison the local index. */
export function decodeIndexRaw(raw: Uint8Array, expected: { model: string; dims: number }): IndexRow[] {
  if (raw.length < 13 || ascii(raw, 0, 4) !== MAGIC) throw new Error('Not a Brewhall semantic index');
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const dims = view.getUint32(4, true);
  const count = view.getUint32(8, true);
  const modelLen = view.getUint8(12);
  const model = new TextDecoder().decode(raw.subarray(13, 13 + modelLen));
  if (model !== expected.model) throw new Error(`Index is for model ${model}, not ${expected.model}`);
  if (dims !== expected.dims) throw new Error(`Index has ${dims} dimensions, expected ${expected.dims}`);
  const start = 13 + modelLen;
  const stride = ID_LEN + 4 + dims;
  if (raw.length !== start + count * stride) throw new Error('Index file is truncated or has trailing data');
  const rows: IndexRow[] = [];
  for (let i = 0; i < count; i++) {
    const at = start + i * stride;
    const id = ascii(raw, at, at + ID_LEN);
    if (!UUID.test(id)) throw new Error(`Index row ${i} has an invalid id`);
    rows.push({ id, hash: view.getUint32(at + ID_LEN, true), vec: raw.slice(at + ID_LEN + 4, at + stride) });
  }
  return rows;
}
