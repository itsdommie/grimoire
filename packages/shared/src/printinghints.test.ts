import { describe, expect, it } from 'vitest';
import { collectorDigits, readPrintingHints } from './printinghints.js';

// Real ML Kit output for the bottom of real cards (the lines are exactly what the plugin returned).
describe('readPrintingHints, on real OCR output', () => {
  it.each([
    ['MM2 #198', ['counter from Shrewd Hatchling.', '198/249 U', 'MM2• EN ► CARL FRANK', '6/6', 'IM & 2015 Wizards of the Coast'], { set: 'mm2', number: '198', year: 2015 }],
    ['BFZ #152', ['152/274', 'BFZ • EN > VOLKAN BAGA', '2/2', 'TM & O2015 W\'izards of the Coast'], { set: 'bfz', number: '152', year: 2015 }],
    ['FRF #91 (copyright read as O)', ['-Alesha, Who Smiles at Death', 'O91/185 R', 'FRF• EN ►SLAWOMIR MANIAK', 'TM & O 2015 Wizards of the Coast'], { set: 'frf', number: '91', year: 2015 }],
    ['ORI #196', ['and it becomes renowned.)', '196/272', 'ORI•EN >ZOLTAN BOROs', '4/4', 'TM &O 2015 Wizards of the Coast'], { set: 'ori', number: '196', year: 2015 }],
    ['CN2 #205 (digit in the set code)', ['205/221 U', 'CN2• EN PETER MOHRBACHER', 'TM &O 2016 Wizards of the Coast'], { set: 'cn2', number: '205', year: 2016 }],
    ['KHM #59 (no bullet)', ['Equip 2', 'O59/285 U', 'KHM EN loSEPH MEEHAN', 'IN &C2021 Wizards of the Coast'], { set: 'khm', number: '59', year: 2021 }],
    ['HOB #4 (rarity letter, zeros read as O)', ['wOuld go and have adventures.', 'R O004', 'HOB• EN >XABI GAZTELUA', 'OMEE', '2/2', 'TM & O 2026 Wizards of the Coast'], { set: 'hob', number: '4', year: 2026 }],
    ['FDN #744 (padded number)', ['things!"', 'C 0744', 'FDN •EN BEN HILL', '2/1', 'TM &2026 Wizards of the Coast'], { set: 'fdn', number: '744', year: 2026 }],
    ['ECL #24 (rarity glued to the number)', ['will calcify into one.', 'CO024', 'ECL • EN >OVIDIO CARTAGENA', 'TM &O 2026 Wizards of the Coast'], { set: 'ecl', number: '24', year: 2026 }],
    ['TRK #94', ['y your blade is as vell!3»', 'U 0094', 'TRK• EN TONY FoTI', 'O 2026 CBS.', 'TM &O 2026 Wizards of the Coast'], { set: 'trk', number: '94', year: 2026 }],
    ['MSC #806 (the set code and language run together)', ['Thor!"', 'U 0806', 'MSCEN >MILIYo ERAN', 'OMARVEL', 'TM & 2026 Wizards of the Coast'], { set: 'msc', number: '806', year: 2026 }],
    ['FRC #21 (zeros read as O)', ['U O021', 'FRC EN >TITUs LUNTER', 'TM &O 2026 Wizards of the Coast'], { set: 'frc', number: '21', year: 2026 }],
    ['TMT #82', ['-Leonardo', 'COo82', 'TMT • EN > KIM SOKOL', 'C2026 Viacom.', 'TM &O 2026 Wizards of the Coast'], { set: 'tmt', number: '82', year: 2026 }],
  ])('%s', (_name, lines, want) => {
    expect(readPrintingHints(lines)).toEqual(want);
  });

  it('old cards give a copyright year at best (no set, no number)', () => {
    expect(readPrintingHints(['Ilus. Tom Winerstrand', 'D1994 Wizards of the Coast, Inc. All rights reserved.', '2/2'])).toEqual({ year: 1994 });
    expect(readPrintingHints(['Illus: © 1994 Anson Maddocks', '0/T'])).toEqual({ year: 1994 });
    expect(readPrintingHints(['Ilus. Steve Luke', 'Di996 Vizards of the Coast, Jnc. All rights reserved.', '1/3'])).toEqual({ year: 1996 });
    expect(readPrintingHints(['C1997 Wizards of the Coast, Iac. All rightsreserved.'])).toEqual({ year: 1997 });
  });
  it('flavour text and artist lines are not mistaken for a set code', () => {
    expect(readPrintingHints(['"We are the golden ones," she said.', 'Illus. Ben Hill'])).toEqual({});
    expect(readPrintingHints(['Seven for the dwarf-lords in their halls of stone.'])).toEqual({});
  });
  it('a bare power/toughness or flavour text is not a collector number', () => {
    expect(readPrintingHints(['2/2'])).toEqual({});
    expect(readPrintingHints(['6/6', 'it all!'])).toEqual({});
    expect(readPrintingHints([])).toEqual({});
  });
});

describe('collectorDigits', () => {
  it('compares collector numbers by their digits', () => {
    expect(collectorDigits('0021')).toBe('21');
    expect(collectorDigits('21★')).toBe('21');
    expect(collectorDigits('21a')).toBe('21');
    expect(collectorDigits('0')).toBe('0');
    expect(collectorDigits('A-5')).toBe('5');
    expect(collectorDigits('abc')).toBe('');
  });
});
