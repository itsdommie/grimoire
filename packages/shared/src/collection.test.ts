import { describe, expect, it } from 'vitest';
import { parseCollection, parseCsv } from './collection.js';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, embedded commas/newlines, CRLF, BOM and blank lines', () => {
    const csv = '﻿Name,Note\r\n"Jace, Vryn\'s Prodigy","said ""hi"""\r\n\r\n"multi\nline",x\r\nlast,row';
    expect(parseCsv(csv)).toEqual([
      ['Name', 'Note'],
      ["Jace, Vryn's Prodigy", 'said "hi"'],
      ['multi\nline', 'x'],
      ['last', 'row'],
    ]);
  });
  it('keeps empty fields and a final row without a trailing newline', () => {
    expect(parseCsv('a,,c\n,b,')).toEqual([['a', '', 'c'], ['', 'b', '']]);
  });
});

describe('parseCollection', () => {
  it('ManaBox export', () => {
    const csv = 'Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Condition,Language,Purchase price currency\n'
      + 'Sol Ring,CMM,Commander Masters,400,normal,uncommon,2,123,abc,1.00,false,false,near_mint,en,USD\n'
      + '"Fire // Ice",MH2,Modern Horizons 2,290,foil,rare,1,124,def,0,false,false,near_mint,en,USD';
    const r = parseCollection(csv);
    expect(r.format).toBe('manabox');
    expect(r.rows).toEqual([
      { name: 'Sol Ring', qty: 2, set: 'cmm', collector: '400' },
      { name: 'Fire // Ice', qty: 1, set: 'mh2', collector: '290' },
    ]);
  });
  it('Moxfield export', () => {
    const csv = '"Count","Tradelist Count","Name","Edition","Condition","Language","Foil","Tags","Last Modified","Collector Number","Alter","Proxy","Purchase Price"\n'
      + '"3","0","Rhystic Study","jud","Near Mint","English","","","2024-01-01","47","False","False",""';
    const r = parseCollection(csv);
    expect(r.format).toBe('moxfield');
    expect(r.rows).toEqual([{ name: 'Rhystic Study', qty: 3, set: 'jud', collector: '47' }]);
  });
  it('Archidekt and Deckbox style exports', () => {
    expect(parseCollection('Quantity,Name,Finish,Condition,Date Added,Language,Purchase Price,Tags,Edition Name,Edition Code,Multiverse Id,Scryfall ID,MTGO ID,Collector Number,Mana Value,Colors,Identities,Mana cost,Types,Sub-types,Super-types,Rarity,Price (Card Kingdom),Price (TCG Player),Price (Star City Games),Price (Card Hoarder),Price (Card Market),Scryfall Oracle ID\n2,Cultivate,Normal,NM,2024,English,,,Foo,c21,1,xyz,2,200,3,G,G,{2}{G},Sorcery,,,common,,,,,,oid').format).toBe('archidekt');
    const dk = parseCollection('Count,Tradelist Count,Name,Foil,Textless,Promo,Signed,Edition,Condition,Language,Card Number\n1,0,Counterspell,,,,,Dominaria United Commander,Near Mint,English,102');
    expect(dk.format).toBe('deckbox');
    expect(dk.rows[0]).toMatchObject({ name: 'Counterspell', qty: 1 });
  });
  it('generic CSV: name column only means quantity 1; unknown quantity is skipped and reported', () => {
    const r = parseCollection('Card Name,Qty\nSol Ring,\nArcane Signet,two\n"Command Tower",4');
    expect(r.format).toBe('csv');
    expect(r.rows).toEqual([{ name: 'Sol Ring', qty: 1 }, { name: 'Command Tower', qty: 4 }]);
    expect(r.skipped).toEqual(['Arcane Signet (quantity "two")']);
  });
  it('plain text lists, including decorations', () => {
    const r = parseCollection('4 Lightning Bolt\n1x Sol Ring (CMM) 400 *F*\nCounterspell');
    expect(r.format).toBe('text');
    expect(r.rows.map((x) => [x.name, x.qty])).toEqual([['Lightning Bolt', 4], ['Sol Ring', 1], ['Counterspell', 1]]);
  });
  it('a CSV without a recognisable name column falls back to text and yields nothing useful', () => {
    expect(parseCollection('foo,bar\n1,2').format).toBe('text');
  });
});
