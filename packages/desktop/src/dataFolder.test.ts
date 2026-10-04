import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adoptLegacyDataFolder } from './dataFolder';

const appData = () => mkdtempSync(join(tmpdir(), 'brewhall-appdata-'));

describe('keeping the data of an app that used to be called Grimoire', () => {
  it('moves the old folder to the new name, with everything in it', () => {
    const base = appData();
    mkdirSync(join(base, 'Grimoire', 'data'), { recursive: true });
    writeFileSync(join(base, 'Grimoire', 'data', 'grimoire.db'), 'my decks');
    const used = adoptLegacyDataFolder(join(base, 'Brewhall'), 'Grimoire');
    expect(used).toBe(join(base, 'Brewhall'));
    expect(readFileSync(join(base, 'Brewhall', 'data', 'grimoire.db'), 'utf8')).toBe('my decks');
    expect(existsSync(join(base, 'Grimoire'))).toBe(false);
  });

  it('leaves a fresh install alone', () => {
    const base = appData();
    expect(adoptLegacyDataFolder(join(base, 'Brewhall'), 'Grimoire')).toBe(join(base, 'Brewhall'));
    expect(existsSync(join(base, 'Brewhall'))).toBe(false);
  });

  it('never touches data that is already in the new folder (an old folder beside it stays where it is)', () => {
    const base = appData();
    mkdirSync(join(base, 'Grimoire'), { recursive: true }); writeFileSync(join(base, 'Grimoire', 'old'), 'old');
    mkdirSync(join(base, 'Brewhall'), { recursive: true }); writeFileSync(join(base, 'Brewhall', 'new'), 'new');
    expect(adoptLegacyDataFolder(join(base, 'Brewhall'), 'Grimoire')).toBe(join(base, 'Brewhall'));
    expect(readFileSync(join(base, 'Grimoire', 'old'), 'utf8')).toBe('old');
    expect(readFileSync(join(base, 'Brewhall', 'new'), 'utf8')).toBe('new');
  });

  it('carries on with the old folder if it cannot be moved, rather than start from nothing', () => {
    const base = appData();
    mkdirSync(join(base, 'Grimoire'), { recursive: true });
    const used = adoptLegacyDataFolder(join(base, 'Brewhall'), 'Grimoire', { exists: existsSync, rename: () => { throw new Error('in use'); } });
    expect(used).toBe(join(base, 'Grimoire'));
  });

  it('does nothing when the app is still using the old name (a relocated or portable data folder)', () => {
    const base = appData();
    expect(adoptLegacyDataFolder(join(base, 'Grimoire'), 'Grimoire')).toBe(join(base, 'Grimoire'));
    expect(adoptLegacyDataFolder('/somewhere/else/entirely', 'Grimoire')).toBe('/somewhere/else/entirely');
  });
});
