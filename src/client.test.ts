import { describe, expect, it, vi } from 'vitest';
import { TwoGisApiError, TwoGisClient } from './client.js';
import { MemorySessionStore } from './session.js';

type Handler = (url: URL, init: RequestInit) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;

function fakeFetch(handler: Handler) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const { status = 200, body } = await handler(url, init);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const ok = (result: unknown) => ({ body: { meta: { code: 200 }, result } });
const tokens = (n: number) => ok({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 3600 });
const header = (init: RequestInit, name: string) => (init.headers as Record<string, string>)[name];

describe('TwoGisClient', () => {
  it('refreshes with the seed refresh token and persists the new session', async () => {
    const store = new MemorySessionStore();
    const { fetch, calls } = fakeFetch((url) =>
      url.pathname.endsWith('users/refreshToken') ? tokens(1) : ok({ items: [] }),
    );
    const api = new TwoGisClient({ store, fetch, apiKey: 'k', refreshToken: 'seed' });

    await api.get('orgs');

    expect(JSON.parse(String(calls[0].init.body))).toEqual({ refreshToken: 'seed' });
    expect(header(calls[0].init, 'Authorization')).toBeUndefined();
    expect(header(calls[1].init, 'Authorization')).toBe('Bearer access-1');
    expect(header(calls[1].init, 'X-Api-Key')).toBe('k');
    expect((await store.load())?.refreshToken).toBe('refresh-1');
  });

  it('reuses a valid stored token without re-authenticating', async () => {
    const store = new MemorySessionStore({ accessToken: 'stored', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 });
    const { fetch, calls } = fakeFetch(() => ok({}));
    await new TwoGisClient({ store, fetch, apiKey: 'k' }).get('orgs');
    expect(calls).toHaveLength(1);
    expect(header(calls[0].init, 'Authorization')).toBe('Bearer stored');
  });

  it('refreshes and retries once on 401', async () => {
    const store = new MemorySessionStore({ accessToken: 'stale', refreshToken: 'r0', expiresAt: 0 });
    const { fetch, calls } = fakeFetch((url, init) => {
      if (url.pathname.endsWith('users/refreshToken')) return tokens(2);
      return header(init, 'Authorization') === 'Bearer stale' ? { status: 401, body: { meta: { code: 401 } } } : ok({ fine: true });
    });
    const res = await new TwoGisClient({ store, fetch, apiKey: 'k' }).get<{ fine: boolean }>('orgs');
    expect(res).toEqual({ fine: true });
    expect(calls.map((c) => c.url.pathname.split('/').pop())).toEqual(['orgs', 'refreshToken', 'orgs']);
  });

  it('falls back to login/password when refresh fails', async () => {
    const store = new MemorySessionStore({ accessToken: '', refreshToken: 'dead', expiresAt: 0 });
    const { fetch, calls } = fakeFetch((url) => {
      if (url.pathname.endsWith('users/refreshToken')) return { status: 400, body: { meta: { code: 400 } } };
      if (url.pathname.endsWith('users/auth')) return tokens(3);
      return ok({});
    });
    await new TwoGisClient({ store, fetch, apiKey: 'k', login: 'u', password: 'p' }).get('orgs');
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ login: 'u', password: 'p' });
    expect(header(calls[2].init, 'Authorization')).toBe('Bearer access-3');
  });

  it('shares one refresh between concurrent requests', async () => {
    const store = new MemorySessionStore();
    const { fetch, calls } = fakeFetch((url) => (url.pathname.endsWith('users/refreshToken') ? tokens(4) : ok({})));
    const api = new TwoGisClient({ store, fetch, apiKey: 'k', refreshToken: 'seed' });
    await Promise.all([api.get('a'), api.get('b'), api.get('c')]);
    expect(calls.filter((c) => c.url.pathname.endsWith('refreshToken'))).toHaveLength(1);
  });

  it('reads the API key from APP_CONFIG when not configured', async () => {
    const store = new MemorySessionStore({ accessToken: 't', refreshToken: '', expiresAt: 0 });
    const { fetch, calls } = fakeFetch((url) =>
      url.host === 'account.2gis.com'
        ? { body: '<script>window.APP_CONFIG = {"lkApiKeyWeb":"web-key","x":1}</script>' }
        : ok({}),
    );
    await new TwoGisClient({ store, fetch }).get('orgs');
    expect(header(calls[1].init, 'X-Api-Key')).toBe('web-key');
  });

  it('throws TwoGisApiError with meta errors and builds query strings', async () => {
    const store = new MemorySessionStore({ accessToken: 't', refreshToken: '', expiresAt: 0 });
    const { fetch, calls } = fakeFetch(() => ({ status: 422, body: { meta: { code: 422, errors: { error: 'bad text' } } } }));
    const api = new TwoGisClient({ store, fetch, apiKey: 'k' });
    const err = await api.get('x', { a: 1, skip: undefined, empty: '' }).catch((e) => e);
    expect(err).toBeInstanceOf(TwoGisApiError);
    expect(err.status).toBe(422);
    expect(err.message).toContain('bad text');
    expect(calls[0].url.search).toBe('?a=1');
  });

  it('explains missing credentials', async () => {
    const { fetch } = fakeFetch(() => ok({}));
    await expect(new TwoGisClient({ store: new MemorySessionStore(), fetch, apiKey: 'k' }).get('orgs')).rejects.toThrow(
      /TWOGIS_REFRESH_TOKEN/,
    );
  });
});
