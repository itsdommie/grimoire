import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, request } from './api';

const stubFetch = (res: Partial<Response> & { json?: () => Promise<unknown> }) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, ...res })));
afterEach(() => vi.unstubAllGlobals());

describe('request', () => {
  it('returns parsed JSON', async () => {
    stubFetch({ json: async () => ({ total: 3 }) });
    expect(await request('GET', '/x')).toEqual({ total: 3 });
  });

  it('regression: an abort while the body is being read stays an abort (it used to become `{}` and crash the search UI)', async () => {
    const ctrl = new AbortController();
    stubFetch({ json: async () => { ctrl.abort(); throw new DOMException('The operation was aborted.', 'AbortError'); } });
    await expect(request('GET', '/x', undefined, ctrl.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('turns error responses into ApiError with the server message and body', async () => {
    stubFetch({ ok: false, status: 400, json: async () => ({ error: 'Bad query', total: 0, cards: [] }) });
    const err = await request('GET', '/x').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ message: 'Bad query', status: 400, body: { total: 0 } });
  });

  it('copes with an error response that is not JSON', async () => {
    stubFetch({ ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token <'); } });
    await expect(request('GET', '/x')).rejects.toMatchObject({ message: 'Request failed (502)', status: 502 });
  });

  it('204 resolves to undefined', async () => {
    stubFetch({ status: 204 });
    expect(await request('DELETE', '/x')).toBeUndefined();
  });
});
