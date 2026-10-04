/**
 * Telling the person a newer Brewhall is out. The app isn't on a store, so it looks at this project's GitHub releases itself (the
 * API allows web pages to read it). Android releases are the ones tagged `android-v<version>`; desktop releases share the repository
 * and are ignored here.
 */
export interface AppUpdate {
  version: string;
  /** Where to download the APK. */
  url: string;
  /** The release page, for what changed. */
  page: string;
}

interface GithubRelease {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  html_url?: string;
  assets?: Array<{ name?: string; browser_download_url?: string }>;
}

/** "0.2.10" as numbers; null if it isn't a plain dotted version. */
export function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  return false;
}

/** The newest Android release that is newer than `current` and has an APK to download, or null. */
export function newestAndroidUpdate(releases: readonly GithubRelease[], current: string): AppUpdate | null {
  let best: AppUpdate | null = null;
  for (const r of releases) {
    const tag = r.tag_name ?? '';
    if (r.draft || r.prerelease || !tag.startsWith('android-v')) continue;
    const version = tag.slice('android-v'.length);
    const apk = r.assets?.find((a) => a.name?.endsWith('.apk') && a.browser_download_url);
    if (!apk || !parseVersion(version) || !isNewer(version, current)) continue;
    if (!best || isNewer(version, best.version)) best = { version, url: apk.browser_download_url!, page: r.html_url ?? '' };
  }
  return best;
}

export const RELEASES_URL = 'https://api.github.com/repos/itsdommie/grimoire/releases?per_page=30';

export async function checkForAppUpdate(current: string, fetchImpl: typeof fetch = fetch): Promise<AppUpdate | null> {
  const res = await fetchImpl(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`couldn't check for an app update (HTTP ${res.status})`);
  return newestAndroidUpdate((await res.json()) as GithubRelease[], current);
}
