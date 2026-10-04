import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without types
import { sha512Base64, updateLatestYml } from './update-latest-yml.mjs';

const YML = `version: 0.1.1
files:
  - url: Brewhall-Setup-0.1.1.exe
    sha512: OLDHASH==
    size: 111
path: Brewhall-Setup-0.1.1.exe
sha512: OLDHASH==
releaseDate: '2026-10-03T01:44:01.582Z'
`;

describe('update-latest-yml', () => {
  it('rewrites the checksum and size everywhere the installer appears, and nothing else', () => {
    const out = updateLatestYml(YML, 'Brewhall-Setup-0.1.1.exe', 'NEWHASH==', 222);
    expect(out).toBe(`version: 0.1.1
files:
  - url: Brewhall-Setup-0.1.1.exe
    sha512: NEWHASH==
    size: 222
path: Brewhall-Setup-0.1.1.exe
sha512: NEWHASH==
releaseDate: '2026-10-03T01:44:01.582Z'
`);
  });
  it('leaves other files in the feed alone', () => {
    const feed = YML.replace('files:\n', 'files:\n  - url: other.exe\n    sha512: KEEP==\n    size: 5\n');
    const out = updateLatestYml(feed, 'Brewhall-Setup-0.1.1.exe', 'NEWHASH==', 222);
    expect(out).toContain('url: other.exe\n    sha512: KEEP==\n    size: 5');
  });
  it('refuses to guess when the installer is not in the feed', () => {
    expect(() => updateLatestYml(YML, 'Missing.exe', 'x', 1)).toThrow(/Expected to update/);
  });
  it('computes the same base64 sha512 that electron-updater verifies', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'sign-')), 'a.exe');
    writeFileSync(f, 'signed bytes');
    expect(sha512Base64(f)).toBe(createHash('sha512').update(readFileSync(f)).digest('base64'));
  });
});
