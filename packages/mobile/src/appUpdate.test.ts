import { describe, expect, it } from 'vitest';
import { checkForAppUpdate, isNewer, newestAndroidUpdate, parseVersion } from './appUpdate';

const release = (tag: string, extra: object = {}) => ({ tag_name: tag, html_url: `https://example/${tag}`, assets: [{ name: `Brewhall-${tag.replace('android-v', '')}-android.apk`, browser_download_url: `https://example/${tag}.apk` }, { name: 'x.apk.sha256', browser_download_url: 'https://example/sha' }], ...extra });

describe('versions', () => {
  it('parses plain dotted versions only', () => {
    expect(parseVersion('0.1.0')).toEqual([0, 1, 0]);
    expect(parseVersion('v1.20.3')).toEqual([1, 20, 3]);
    expect(parseVersion('1.0')).toBeNull();
    expect(parseVersion('1.0.0-beta')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });
  it('compares by number, not by text', () => {
    expect(isNewer('0.1.10', '0.1.9')).toBe(true);
    expect(isNewer('0.2.0', '0.1.99')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('0.1.0', '0.1.1')).toBe(false);
    expect(isNewer('garbage', '0.1.0')).toBe(false);
    expect(isNewer('0.1.1', 'garbage')).toBe(false);
  });
});

describe('newestAndroidUpdate', () => {
  it('picks the newest Android release that is newer than this one, with its APK', () => {
    const u = newestAndroidUpdate([release('android-v0.1.0'), release('android-v0.3.0'), release('android-v0.2.0')], '0.1.0');
    expect(u).toEqual({ version: '0.3.0', url: 'https://example/android-v0.3.0.apk', page: 'https://example/android-v0.3.0' });
  });
  it('ignores desktop releases, drafts, prereleases, releases without an APK and unusable tags', () => {
    const releases = [
      { tag_name: 'v0.3.0', html_url: 'x', assets: [{ name: 'a.apk', browser_download_url: 'u' }] }, // a desktop tag
      release('android-v9.0.0', { draft: true }),
      release('android-v8.0.0', { prerelease: true }),
      { tag_name: 'android-v7.0.0', html_url: 'x', assets: [{ name: 'notes.txt', browser_download_url: 'u' }] },
      release('android-vbeta'),
      release('android-v0.2.0'),
    ];
    expect(newestAndroidUpdate(releases, '0.1.0')?.version).toBe('0.2.0');
  });
  it('says nothing when you are up to date or ahead', () => {
    expect(newestAndroidUpdate([release('android-v0.1.0')], '0.1.0')).toBeNull();
    expect(newestAndroidUpdate([release('android-v0.1.0')], '0.2.0')).toBeNull();
    expect(newestAndroidUpdate([], '0.1.0')).toBeNull();
  });
});

describe('checkForAppUpdate', () => {
  it('asks GitHub for the releases and reports an update, or an error', async () => {
    const ok = (async () => Response.json([release('android-v0.2.0')])) as typeof fetch;
    expect((await checkForAppUpdate('0.1.0', ok))?.version).toBe('0.2.0');
    const down = (async () => new Response('rate limited', { status: 403 })) as typeof fetch;
    await expect(checkForAppUpdate('0.1.0', down)).rejects.toThrow(/HTTP 403/);
  });
});
