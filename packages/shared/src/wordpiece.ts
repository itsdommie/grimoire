// BERT-style WordPiece tokenizer (uncased), as used by BGE embedding models. Pure TypeScript so it's testable in Node and reusable anywhere.

export interface TokenizerVocab {
  vocab: Record<string, number>;
}

const isAsciiPunct = (c: number) => (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
// BERT treats every ASCII non-alphanumeric as punctuation, plus Unicode punctuation categories (not all symbols).
const isPunct = (ch: string) => isAsciiPunct(ch.charCodeAt(0)) || /\p{P}/u.test(ch);
const isCjk = (cp: number) =>
  (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x20000 && cp <= 0x2a6df) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x2f800 && cp <= 0x2fa1f);

export class WordPieceTokenizer {
  private readonly vocab: Map<string, number>;
  readonly cls: number;
  readonly sep: number;
  readonly unk: number;
  readonly pad: number;

  constructor(vocab: Record<string, number>) {
    this.vocab = new Map(Object.entries(vocab));
    const need = (t: string) => { const id = this.vocab.get(t); if (id === undefined) throw new Error(`Vocabulary has no ${t} token`); return id; };
    this.cls = need('[CLS]'); this.sep = need('[SEP]'); this.unk = need('[UNK]'); this.pad = need('[PAD]');
  }

  /** Build from the contents of a Hugging Face tokenizer.json (WordPiece model). */
  static fromTokenizerJson(json: string): WordPieceTokenizer {
    const parsed = JSON.parse(json) as { model?: { type?: string; vocab?: Record<string, number> } };
    if (parsed.model?.type !== 'WordPiece' || !parsed.model.vocab) throw new Error('Not a WordPiece tokenizer.json');
    return new WordPieceTokenizer(parsed.model.vocab);
  }

  /** Lower-case, strip accents, drop control characters, and split into words and single punctuation marks. */
  basicTokens(text: string): string[] {
    const cleaned = text.normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase();
    const out: string[] = [];
    let cur = '';
    const flush = () => { if (cur) { out.push(cur); cur = ''; } };
    for (const ch of cleaned) {
      const cp = ch.codePointAt(0)!;
      if (cp === 0 || cp === 0xfffd || (cp < 32 && ch !== '\t' && ch !== '\n' && ch !== '\r') || /[\p{Cc}\p{Cf}]/u.test(ch) && !/\s/.test(ch)) continue;
      if (/\s/.test(ch)) flush();
      else if (isPunct(ch) || isCjk(cp)) { flush(); out.push(ch); }
      else cur += ch;
    }
    flush();
    return out;
  }

  private wordPieces(word: string): number[] {
    if ([...word].length > 100) return [this.unk];
    const chars = [...word];
    const pieces: number[] = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length;
      let found: number | undefined;
      while (start < end) {
        const sub = (start > 0 ? '##' : '') + chars.slice(start, end).join('');
        const id = this.vocab.get(sub);
        if (id !== undefined) { found = id; break; }
        end--;
      }
      if (found === undefined) return [this.unk]; // a single unknown piece makes the whole word [UNK]
      pieces.push(found);
      start = end;
    }
    return pieces;
  }

  /** Token ids with [CLS] ... [SEP], truncated to `maxLen` (the [SEP] is always kept). */
  encode(text: string, maxLen = 512): number[] {
    const ids = [this.cls];
    outer: for (const word of this.basicTokens(text)) {
      for (const id of this.wordPieces(word)) {
        if (ids.length >= maxLen - 1) break outer;
        ids.push(id);
      }
    }
    ids.push(this.sep);
    return ids;
  }
}
