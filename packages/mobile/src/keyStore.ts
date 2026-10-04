import type { KeyStore } from '../../server/src/advisor.ts';
import type { NativeRequest, NativeResult } from './protocol.ts';

/** The advisor's key, unless another secret is asked for (the Google sign-in). */
const ADVISOR_KEY = 'anthropic-key';

/**
 * A small secret on the phone (by default the advisor's API key): kept by the Android Keystore through the native side, with a copy in memory
 * so the router can read it synchronously. (Outside the app, in tests, there is no native side and the key lives only as long as the page.)
 */
export async function phoneKeyStore(native: ((request: NativeRequest) => Promise<NativeResult>) | null, name = ADVISOR_KEY): Promise<KeyStore> {
  if (!native) {
    let key: string | null = null;
    return { canStore: true, get: () => key, set: (k) => { key = k; }, clear: () => { key = null; } };
  }
  const first = await native({ op: 'secret-get', name });
  let cached = first.ok ? first.text ?? null : null;
  return {
    canStore: true,
    get: () => cached,
    async set(key) {
      const r = await native({ op: 'secret-set', name, value: key });
      if (!r.ok) throw new Error(`Couldn't save the key (${r.error})`);
      cached = key;
    },
    async clear() {
      await native({ op: 'secret-clear', name });
      cached = null;
    },
  };
}
