import type { KeyStore } from '../../server/src/advisor.ts';
import type { NativeRequest, NativeResult } from './protocol.ts';

const NAME = 'anthropic-key';

/**
 * The advisor's API key on the phone: kept by the Android Keystore through the native side, with a copy in memory so the router can
 * read it synchronously. (Outside the app, in tests, there is no native side and the key lives only as long as the page.)
 */
export async function phoneKeyStore(native: ((request: NativeRequest) => Promise<NativeResult>) | null): Promise<KeyStore> {
  if (!native) {
    let key: string | null = null;
    return { canStore: true, get: () => key, set: (k) => { key = k; }, clear: () => { key = null; } };
  }
  const first = await native({ op: 'secret-get', name: NAME });
  let cached = first.ok ? first.text ?? null : null;
  return {
    canStore: true,
    get: () => cached,
    async set(key) {
      const r = await native({ op: 'secret-set', name: NAME, value: key });
      if (!r.ok) throw new Error(`Couldn't save the key (${r.error})`);
      cached = key;
    },
    async clear() {
      await native({ op: 'secret-clear', name: NAME });
      cached = null;
    },
  };
}
