import { describe, expect, it } from 'vitest';
import { NameIndex, boundedDistance, normalizeName } from './cardmatch.js';

const index = new NameIndex([
  { id: 'sol', name: 'Sol Ring' },
  { id: 'solemn', name: 'Solemn Offering' },
  { id: 'fire', name: 'Fire // Ice' },
  { id: 'atraxa', name: "Atraxa, Praetors' Voice" },
  { id: 'lim', name: 'Lim-Dûl the Necromancer' },
  { id: 'aether', name: 'Æther Vial' },
  { id: 'horn', name: 'Avengers Monitoring Station' },
  { id: 'ring2', name: 'Ring of Valkas' },
]);
const top = (text: string) => index.match(text)[0];

describe('normalizeName', () => {
  it('keeps lowercase letters and digits only', () => {
    expect(normalizeName("Atraxa, Praetors' Voice")).toBe('atraxa praetors voice');
    expect(normalizeName('Lim-Dûl the Necromancer')).toBe('lim dul the necromancer');
    expect(normalizeName('Æther Vial')).toBe('aether vial');
    expect(normalizeName('  Sol\n Ring  ')).toBe('sol ring');
  });
});

describe('boundedDistance', () => {
  it('is the edit distance, and gives up early past the bound', () => {
    expect(boundedDistance('kitten', 'sitting', 5)).toBe(3);
    expect(boundedDistance('abc', 'abc', 0)).toBe(0);
    expect(boundedDistance('abcdef', 'uvwxyz', 2)).toBe(3);
    expect(boundedDistance('a', 'abcdefgh', 2)).toBe(3);
  });
});

describe('NameIndex', () => {
  it('matches exactly, ignoring case, accents and punctuation', () => {
    expect(top('SOL RING')).toMatchObject({ id: 'sol', score: 1 });
    expect(top("atraxa praetors' voice")).toMatchObject({ id: 'atraxa', score: 1 });
    expect(top('Lim-Dul the Necromancer')).toMatchObject({ id: 'lim', score: 1 });
  });
  it('tolerates the usual OCR slips', () => {
    expect(top('Sol Rlng')?.id).toBe('sol');
    expect(top('S0l Ring')?.id).toBe('sol');
    expect(top('Atraxa Praetors Vo1ce')?.id).toBe('atraxa');
    expect(top('Avengers Monitoring Statlon')?.id).toBe('horn');
  });
  it('ignores short junk after the name (the mana cost) and finds either face of a double-faced card', () => {
    expect(top('Sol Ring 1')?.id).toBe('sol');
    expect(top('Sol Ring (1 e')?.id).toBe('sol');
    expect(top('Fire')?.id).toBe('fire');
    expect(top('Ice')?.id).toBe('fire');
    expect(top('Fire // Ice')?.id).toBe('fire');
  });
  it('prefers the closer name when several are similar, and lists each card once', () => {
    const r = index.match('Sol Ring');
    expect(r[0]!.id).toBe('sol');
    expect(new Set(r.map((m) => m.id)).size).toBe(r.length);
  });
  it('finds nothing for noise or an empty read', () => {
    expect(index.match('')).toEqual([]);
    expect(index.match('   ')).toEqual([]);
    expect(index.match('qzxv wjkp')).toEqual([]);
    expect(index.match('x')).toEqual([]);
  });
  it('indexes a double-faced card under each face and its full name only once per card', () => {
    expect(index.size).toBe(10); // 7 single names + Fire, Ice, Fire // Ice
  });
});
