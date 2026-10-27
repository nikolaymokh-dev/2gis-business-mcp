import type { Session, SessionStore } from './session.js';

export const ACCOUNT_API = 'https://api.account.2gis.com/api/1.0/';
export const ACCOUNT_WEB = 'https://account.2gis.com/';

/** Refresh this long before the reported expiry to avoid racing it. */
const EXPIRY_MARGIN_MS = 60_000;

export class TwoGisApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'TwoGisApiError';
  }
}

export interface ClientOptions {
  store: SessionStore;
  apiKey?: string;
  login?: string;
  password?: string;
  /** Seed refresh token, used when the store is empty. */
  refreshToken?: string;
  locale?: string;
  fetch?: typeof fetch;
}

type Query = Record<string, string | number | boolean | undefined | null>;

interface RequestOptions {
  query?: Query;
  body?: unknown;
  auth?: boolean;
}

interface Envelope<T> {
  meta?: { code?: number; errors?: unknown };
  result?: T;
}

interface TokenResult {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

export class TwoGisClient {
  private readonly fetch: typeof fetch;
  private apiKey?: string;
  private session: Session | null = null;
  private loaded = false;
  private pendingAuth: Promise<string> | null = null;

  constructor(private readonly opts: ClientOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.apiKey = opts.apiKey;
  }

  get<T>(path: string, query?: Query) {
    return this.request<T>('GET', path, { query });
  }
  post<T>(path: string, body?: unknown, query?: Query) {
    return this.request<T>('POST', path, { body, query });
  }
  put<T>(path: string, body?: unknown) {
    return this.request<T>('PUT', path, { body });
  }
  delete<T>(path: string, query?: Query) {
    return this.request<T>('DELETE', path, { query });
  }

  async request<T>(method: string, path: string, { query, body, auth = true }: RequestOptions = {}): Promise<T> {
    let res = await this.send(method, path, query, body, auth ? await this.accessToken() : undefined);
    if (res.status === 401 && auth) {
      res = await this.send(method, path, query, body, await this.accessToken(true));
    }

    const text = await res.text();
    let json: Envelope<T> | undefined;
    try {
      json = text ? (JSON.parse(text) as Envelope<T>) : undefined;
    } catch {
      // non-JSON body (HTML error page) — reported below
    }

    const code = json?.meta?.code ?? res.status;
    if (!res.ok || code >= 400) {
      const detail = json?.meta?.errors ? JSON.stringify(json.meta.errors) : text.slice(0, 300);
      throw new TwoGisApiError(code, `2GIS ${method} ${path} failed (${code}): ${detail}`, json);
    }
    return (json?.result ?? (json as T)) as T;
  }

  private async send(method: string, path: string, query: Query | undefined, body: unknown, token?: string) {
    const url = new URL(path.replace(/^\//, ''), ACCOUNT_API);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Locale: this.opts.locale ?? 'ru',
      'X-Api-Key': await this.resolveApiKey(),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return this.fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** The web cabinet key is public: it ships in window.APP_CONFIG on account.2gis.com. */
  private async resolveApiKey(): Promise<string> {
    if (this.apiKey) return this.apiKey;
    const html = await (await this.fetch(ACCOUNT_WEB)).text();
    const match = html.match(/window\.APP_CONFIG\s*=\s*(\{.*?\});?\s*<\/script>/s);
    const key = match ? (JSON.parse(match[1]) as { lkApiKeyWeb?: string }).lkApiKeyWeb : undefined;
    if (!key) throw new Error('Could not read lkApiKeyWeb from account.2gis.com; set TWOGIS_API_KEY');
    this.apiKey = key;
    return key;
  }

  private async accessToken(force = false): Promise<string> {
    if (!this.loaded) {
      this.session = await this.opts.store.load();
      this.loaded = true;
    }
    const s = this.session;
    if (!force && s?.accessToken && (s.expiresAt === 0 || s.expiresAt - EXPIRY_MARGIN_MS > Date.now())) {
      return s.accessToken;
    }
    // Concurrent tool calls share one refresh: refresh tokens are typically single-use.
    this.pendingAuth ??= this.reauthenticate().finally(() => {
      this.pendingAuth = null;
    });
    return this.pendingAuth;
  }

  private async reauthenticate(): Promise<string> {
    const refreshToken = this.session?.refreshToken || this.opts.refreshToken;
    if (refreshToken) {
      try {
        return await this.storeTokens(
          await this.request<TokenResult>('POST', 'users/refreshToken', { body: { refreshToken }, auth: false }),
        );
      } catch (err) {
        if (!this.canLogin()) throw err;
      }
    }
    if (this.canLogin()) {
      return this.storeTokens(
        await this.request<TokenResult>('POST', 'users/auth', {
          body: { login: this.opts.login, password: this.opts.password },
          auth: false,
        }),
      );
    }
    throw new Error(
      'No 2GIS credentials: set TWOGIS_REFRESH_TOKEN (cookie dg_refresh_token) or TWOGIS_LOGIN + TWOGIS_PASSWORD',
    );
  }

  private canLogin() {
    return Boolean(this.opts.login && this.opts.password);
  }

  private async storeTokens(t: TokenResult): Promise<string> {
    if (!t?.access_token) throw new Error('2GIS auth response has no access_token');
    this.session = {
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : 0,
    };
    await this.opts.store.save(this.session);
    return t.access_token;
  }
}
