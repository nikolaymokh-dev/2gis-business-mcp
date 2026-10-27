import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Session {
  accessToken: string;
  refreshToken: string;
  /** Unix ms; 0 when unknown. */
  expiresAt: number;
}

export interface SessionStore {
  load(): Promise<Session | null>;
  save(session: Session): Promise<void>;
}

export const defaultSessionPath = () =>
  process.env.TWOGIS_SESSION_FILE ?? join(homedir(), '.config', '2gis-business-mcp', 'session.json');

/** Persists tokens with 0600 permissions so refreshed tokens survive restarts. */
export class FileSessionStore implements SessionStore {
  constructor(private readonly path = defaultSessionPath()) {}

  async load(): Promise<Session | null> {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8')) as Session;
      return data.accessToken || data.refreshToken ? data : null;
    } catch {
      return null;
    }
  }

  async save(session: Session): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, JSON.stringify(session), { mode: 0o600 });
    await chmod(this.path, 0o600);
  }
}

export class MemorySessionStore implements SessionStore {
  constructor(private session: Session | null = null) {}
  async load() {
    return this.session;
  }
  async save(session: Session) {
    this.session = session;
  }
}
