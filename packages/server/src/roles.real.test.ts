import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tagRoles } from '@grimoire/shared';
import { dbPathFor, openDb } from './db.js';
import { resolveCardName } from './cards.js';
import { DEFAULT_DATA_DIR } from './devpaths.js';

// Regression check of the heuristic role tagger against real oracle text. Skipped when `npm run ingest` hasn't been run.
const path = dbPathFor(DEFAULT_DATA_DIR);
const have = existsSync(path);

const EXPECT: Record<string, string> = {
  'Sol Ring': 'ramp', 'Arcane Signet': 'ramp', 'Llanowar Elves': 'ramp', Cultivate: 'ramp', 'Rampant Growth': 'ramp', Farseek: 'ramp', "Kodama's Reach": 'ramp',
  'Smothering Tithe': 'ramp', 'Dockside Extortionist': 'ramp', 'Birds of Paradise': 'ramp', 'Burnished Hart': 'ramp', "Wayfarer's Bauble": 'ramp', 'Explosive Vegetation': 'ramp',
  'Dark Ritual': '', 'Command Tower': '', 'Evolving Wilds': '', 'Grizzly Bears': '', Forest: '',
  'Rhystic Study': 'draw', Divination: 'draw', 'Sign in Blood': 'draw', "Night's Whisper": 'draw', Harmonize: 'draw', 'Phyrexian Arena': 'draw', 'Mystic Remora': 'draw',
  'Fact or Fiction': 'draw', Windfall: 'draw', Opt: 'draw', Brainstorm: 'draw',
  'Swords to Plowshares': 'removal', 'Path to Exile': 'removal', 'Lightning Bolt': 'removal', 'Doom Blade': 'removal', 'Beast Within': 'removal', 'Chaos Warp': 'removal',
  'Generous Gift': 'removal', 'Reality Shift': 'removal', 'Fire // Ice': 'removal', Terminate: 'removal', 'Cyclonic Rift': 'removal',
  'Wrath of God': 'wipe', Damnation: 'wipe', 'Blasphemous Act': 'wipe', 'Toxic Deluge': 'wipe', Farewell: 'wipe', 'Austere Command': 'wipe', 'Pernicious Deed': 'wipe',
  Counterspell: 'counter', 'Swan Song': 'counter', Negate: 'counter', 'Mana Drain': 'counter', 'Force of Will': 'counter',
  'Demonic Tutor': 'tutor', 'Vampiric Tutor': 'tutor', 'Worldly Tutor': 'tutor', 'Enlightened Tutor': 'tutor', Gamble: 'tutor', 'Mystical Tutor': 'tutor',
  'Eternal Witness': 'recursion', Regrowth: 'recursion', 'Animate Dead': 'recursion', Reanimate: 'recursion',
  'Heroic Intervention': 'protection', 'Swiftfoot Boots': 'protection', 'Lightning Greaves': 'protection', "Teferi's Protection": 'protection',
  'Craterhoof Behemoth': 'wincon', "Thassa's Oracle": 'wincon', Exsanguinate: 'wincon', 'Torment of Hailfire': 'wincon', 'Overwhelming Stampede': 'wincon', 'Gray Merchant of Asphodel': 'wincon',
};

describe.skipIf(!have)('role tagger on real cards', () => {
  const db = have ? openDb(path, { readonly: true }) : (undefined as never);
  it.each(Object.entries(EXPECT))('%s', (name, want) => {
    const card = resolveCardName(db, name);
    expect(card, `${name} should exist in the card pool`).not.toBeNull();
    const got = tagRoles(card!);
    const wanted = want.split(' ').filter(Boolean);
    if (wanted.length === 0) expect(got).toEqual([]);
    else for (const w of wanted) expect(got).toContain(w);
  });
});
