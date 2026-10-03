import { describe, expect, it } from 'vitest';
import type { Card, CardMatchCandidate } from '@grimoire/shared';
import { CARD_ASPECT, ScanTracker, guideRect, pickCandidate, titleLines, type OcrResult } from './scanner';

const line = (text: string, top: number, height = 30) => ({ text, left: 10, top, width: 200, height });
const candidate = (score: number): CardMatchCandidate => ({ card: { id: 'x', name: 'X' } as Card, score, line: 'x' });

describe('guideRect', () => {
  it('is a centred card-shaped rectangle that fits the frame', () => {
    for (const [w, h] of [[720, 1280], [1280, 720], [1080, 1080], [480, 640]] as const) {
      const g = guideRect(w, h);
      expect(g.x).toBeCloseTo((1 - g.w) / 2); expect(g.y).toBeCloseTo((1 - g.h) / 2);
      expect(g.x).toBeGreaterThanOrEqual(0); expect(g.y).toBeGreaterThanOrEqual(0); expect(g.w).toBeLessThanOrEqual(0.9 + 1e-9); expect(g.h).toBeLessThanOrEqual(0.8 + 1e-9);
      expect((g.w * w) / (g.h * h)).toBeCloseTo(CARD_ASPECT, 3);
    }
  });
});

describe('titleLines', () => {
  const ocr: OcrResult = { width: 400, height: 560, lines: [line('Rules text that says Flash', 300), line('Sol Ring', 30, 28), line('1', 28, 20), line('Artifact', 300), line('', 40), line('Lightning Bolt', 90, 26)] };
  it('keeps only real lines from the title band, top first', () => {
    expect(titleLines(ocr)).toEqual(['Sol Ring', 'Lightning Bolt']); // not the rules text, the one-character cost, or the empty line
  });
  it('is empty when nothing is up there', () => {
    expect(titleLines({ width: 400, height: 560, lines: [line('Flash', 300)] })).toEqual([]);
  });
});

describe('pickCandidate', () => {
  it('needs a convincing score', () => {
    expect(pickCandidate([])).toBeNull();
    expect(pickCandidate([candidate(0.8)])).toBeNull();
    expect(pickCandidate([candidate(0.9), candidate(0.7)])?.score).toBe(0.9);
    expect(pickCandidate([candidate(0.8)], 0.75)?.score).toBe(0.8);
  });
});

describe('ScanTracker', () => {
  it('accepts a card once it is seen in two of three frames, and only once while it stays there', () => {
    const t = new ScanTracker();
    expect(t.push('sol')).toBeNull();
    expect(t.push('sol')).toBe('sol');
    for (let i = 0; i < 10; i++) expect(t.push('sol')).toBeNull();
  });
  it('ignores a one-frame misread', () => {
    const t = new ScanTracker();
    expect(t.push('wrong')).toBeNull();
    expect(t.push(null)).toBeNull();
    expect(t.push('sol')).toBeNull();
    expect(t.push('sol')).toBe('sol');
  });
  it('lets the same card be scanned again after it was taken away', () => {
    const t = new ScanTracker();
    t.push('sol'); expect(t.push('sol')).toBe('sol');
    expect(t.push(null)).toBeNull();
    expect(t.push('sol')).toBeNull(); // glimpsed again too soon: still the same card in view
    expect(t.push(null)).toBeNull(); expect(t.push(null)).toBeNull(); // gone for two frames
    expect(t.push('sol')).toBeNull();
    expect(t.push('sol')).toBe('sol');
  });
  it('switches straight to a different card, which still has to be confirmed', () => {
    const t = new ScanTracker();
    t.push('sol'); t.push('sol');
    expect(t.push('tower')).toBeNull();
    expect(t.push('tower')).toBe('tower');
  });
  it('reset forgets the locked card', () => {
    const t = new ScanTracker();
    t.push('sol'); t.push('sol');
    t.reset();
    t.push('sol');
    expect(t.push('sol')).toBe('sol');
  });
});
