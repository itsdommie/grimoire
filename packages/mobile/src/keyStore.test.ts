import { describe, expect, it } from 'vitest';
import { phoneKeyStore } from './keyStore.ts';
import type { NativeRequest, NativeResult } from './protocol.ts';

function fakeNative(initial: string | null = null, failSet = false) {
  let stored = initial;
  const calls: string[] = [];
  const fn = async (r: NativeRequest): Promise<NativeResult> => {
    calls.push(r.op);
    if (r.op === 'secret-get') return { ok: true, ...(stored ? { text: stored } : {}) };
    if (r.op === 'secret-set') { if (failSet) return { ok: false, error: 'keystore unavailable' }; stored = r.value; return { ok: true }; }
    if (r.op === 'secret-clear') { stored = null; return { ok: true }; }
    return { ok: false, error: 'unsupported' };
  };
  return { fn, calls, stored: () => stored };
}

describe('the phone key store', () => {
  it('starts with whatever the native store holds, readable synchronously', async () => {
    expect((await phoneKeyStore(fakeNative('sk-ant-saved').fn)).get()).toBe('sk-ant-saved');
    expect((await phoneKeyStore(fakeNative().fn)).get()).toBeNull();
  });

  it('saves to the native store before it reports the key as held, and forgets it on clear', async () => {
    const n = fakeNative();
    const store = await phoneKeyStore(n.fn);
    await store.set('sk-ant-new');
    expect(n.stored()).toBe('sk-ant-new');
    expect(store.get()).toBe('sk-ant-new');
    await store.clear();
    expect(n.stored()).toBeNull();
    expect(store.get()).toBeNull();
  });

  it('does not pretend to hold a key the native store refused', async () => {
    const store = await phoneKeyStore(fakeNative(null, true).fn);
    await expect(store.set('sk-ant-new')).rejects.toThrow(/keystore unavailable/);
    expect(store.get()).toBeNull();
  });

  it('keeps the key in memory only when there is no native side (tests)', async () => {
    const store = await phoneKeyStore(null);
    store.set('sk-ant-x');
    expect(store.get()).toBe('sk-ant-x');
  });
});
