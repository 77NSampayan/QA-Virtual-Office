/**
 * UI/API authentication (docs/security.md): a one-time launch URL sets an HttpOnly,
 * SameSite=Strict session cookie. Session tokens are stored hashed (sha256) in `auth_sessions`.
 *
 * Limitation (documented): cookies are not port-isolated, so another localhost app could read
 * this cookie from the browser. It still blocks other web origins and cookie-less local clients.
 */
import crypto from 'node:crypto';
import type { DB } from './db/index.ts';

export const COOKIE_NAME = 'qavo_session';
export const NONCE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 30 * 24 * 3600_000;

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export class AuthStore {
  private nonces = new Map<string, number>();

  constructor(private db: DB) {}

  /** Single-use, 5-minute launch nonce. */
  createLaunchNonce(now = Date.now()): string {
    for (const [n, exp] of this.nonces) if (exp <= now) this.nonces.delete(n);
    const nonce = crypto.randomBytes(24).toString('hex');
    this.nonces.set(nonce, now + NONCE_TTL_MS);
    return nonce;
  }

  consumeNonce(nonce: unknown, now = Date.now()): boolean {
    if (typeof nonce !== 'string') return false;
    const exp = this.nonces.get(nonce);
    this.nonces.delete(nonce);
    return exp !== undefined && exp > now;
  }

  issueSession(now = Date.now()): string {
    const token = crypto.randomBytes(32).toString('hex');
    this.db
      .prepare('INSERT INTO auth_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)')
      .run(sha256(token), new Date(now).toISOString(), new Date(now + SESSION_TTL_MS).toISOString());
    return token;
  }

  verify(token: string | undefined, now = Date.now()): boolean {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
    const row = this.db.prepare('SELECT expires_at FROM auth_sessions WHERE token_hash = ?').get(sha256(token)) as
      | { expires_at: string }
      | undefined;
    return !!row && Date.parse(row.expires_at) > now;
  }

  verifyHeader(cookieHeader: string | undefined): boolean {
    return this.verify(parseCookies(cookieHeader)[COOKIE_NAME]);
  }

  revoke(token: string | undefined): void {
    if (token) this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(sha256(token));
  }

  revokeAll(): void {
    this.db.prepare('DELETE FROM auth_sessions').run();
  }

  purgeExpired(now = Date.now()): number {
    return this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(new Date(now).toISOString()).changes;
  }
}

export function sessionCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}
export const clearedCookie = `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
