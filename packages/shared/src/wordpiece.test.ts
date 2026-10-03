import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WordPieceTokenizer } from './wordpiece.js';

const vocab: Record<string, number> = { '[PAD]': 0, '[UNK]': 1, '[CLS]': 2, '[SEP]': 3, hello: 4, world: 5, ',': 6, '!': 7, un: 8, '##happi': 9, '##ness': 10, cafe: 11, '$': 12, a: 13, '.': 14, '-': 15 };
const tok = new WordPieceTokenizer(vocab);

describe('WordPieceTokenizer', () => {
  it('lower-cases, splits punctuation and wraps in [CLS]/[SEP]', () => {
    expect(tok.encode('Hello, WORLD!')).toEqual([2, 4, 6, 5, 7, 3]);
  });
  it('splits words into ## pieces, greedily from the longest', () => {
    expect(tok.encode('unhappiness')).toEqual([2, 8, 9, 10, 3]);
  });
  it('maps unknown words to [UNK] as a whole, never a partial word', () => {
    expect(tok.encode('unhappyness hello')).toEqual([2, 1, 4, 3]);
    expect(tok.encode('x'.repeat(150))).toEqual([2, 1, 3]);
  });
  it('strips accents and splits every ASCII symbol like BERT', () => {
    expect(tok.encode('Café')).toEqual([2, 11, 3]);
    expect(tok.encode('$a-a.')).toEqual([2, 12, 13, 15, 13, 14, 3]);
  });
  it('treats whitespace of any kind as a separator and ignores control characters', () => {
    expect(tok.encode('hello\t\n  world\u0000')).toEqual([2, 4, 5, 3]);
  });
  it('truncates to maxLen but always keeps [SEP]', () => {
    const ids = tok.encode('hello hello hello hello hello', 4);
    expect(ids).toEqual([2, 4, 4, 3]);
    expect(tok.encode('', 8)).toEqual([2, 3]);
  });
  it('rejects a vocabulary without special tokens and non-WordPiece JSON', () => {
    expect(() => new WordPieceTokenizer({ hello: 1 })).toThrow(/\[CLS\]/);
    expect(() => WordPieceTokenizer.fromTokenizerJson('{"model":{"type":"BPE"}}')).toThrow(/WordPiece/);
    expect(WordPieceTokenizer.fromTokenizerJson(JSON.stringify({ model: { type: 'WordPiece', vocab } })).encode('hello')).toEqual([2, 4, 3]);
  });
});

// Ground truth from bert-base-uncased (which BGE shares): needs the real file, present once semantic search has been set up.
const real = resolve(process.env.GRIMOIRE_DATA_DIR ?? resolve(__dirname, '../../../data'), 'models/bge-small-en-v1.5/tokenizer.json');
describe.skipIf(!existsSync(real))('real BGE tokenizer.json', () => {
  const t = () => WordPieceTokenizer.fromTokenizerJson(readFileSync(real, 'utf8'));
  it('matches known bert-base-uncased ids', () => {
    expect(t().encode('Hello, world!')).toEqual([101, 7592, 1010, 2088, 999, 102]);
  });
  it('handles card text: symbols, braces and long words', () => {
    const ids = t().encode('{T}: Add {C}{C}. Whenever an opponent casts a spell, you may draw a card.');
    expect(ids[0]).toBe(101);
    expect(ids.at(-1)).toBe(102);
    expect(ids).not.toContain(100); // no [UNK] in ordinary rules text
  });
});
