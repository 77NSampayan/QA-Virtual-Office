import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { COOKIE_NAME, NONCE_TTL_MS } from '../src/auth.ts';
import { dirDump, makeEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await makeEnv({ listen: true, auth: true });
});
afterAll(async () => env.cleanup());

const base = () => ({ host: env.host, origin: env.origin, 'x-qavo-client': '1' });

async function login(): Promise<string> {
  const url = new URL(env.createLaunchUrl());
  const r = await env.app.inject({ method: 'GET', url: url.pathname + url.search, headers: { host: env.host } });
  expect(r.statusCode).toBe(302);
  const setCookie = String(r.headers['set-cookie']);
  return /qavo_session=([a-f0-9]{64})/.exec(setCookie)![1]!;
}

describe('B5: launch-token cookie auth', () => {
  it('without a cookie every data route and the WebSocket return 401', async () => {
    for (const url of ['/api/projects', '/api/sessions', '/api/sessions/x', '/api/sessions/x/events', '/api/notifications', '/api/settings', '/api/integration/status', '/api/export', '/api/backups']) {
      const r = await env.app.inject({ method: 'GET', url, headers: base() });
      expect(r.statusCode, url).toBe(401);
      expect(r.json()).toEqual({ error: 'unauthorized' });
    }
    const mut = await env.app.inject({ method: 'POST', url: '/api/projects', headers: base(), payload: { alias: 'x', path: 'C:\\x\\y' } });
    expect(mut.statusCode).toBe(401);
    const ws = await new Promise<string>((resolve) => {
      const s = new WebSocket(`ws://127.0.0.1:${env.port}/ws`, { origin: env.origin });
      s.on('message', () => (resolve('open'), s.close()));
      s.on('unexpected-response', (req, res) => (resolve(`rejected:${res.statusCode}`), req.destroy()));
      s.on('error', () => resolve('error'));
    });
    expect(ws).toBe('rejected:401');
  });

  it('health and auth status stay open; static UI needs no cookie (it carries no data)', async () => {
    expect((await env.app.inject({ method: 'GET', url: '/api/health', headers: { host: env.host } })).statusCode).toBe(200);
    const st = await env.app.inject({ method: 'GET', url: '/api/auth/status', headers: { host: env.host } });
    expect(st.json()).toEqual({ authRequired: true, authenticated: false });
    expect((await env.app.inject({ method: 'GET', url: '/', headers: { host: env.host } })).statusCode).toBe(200);
  });

  it('the launch URL logs in once: HttpOnly + SameSite=Strict cookie, then the nonce is spent', async () => {
    const url = new URL(env.createLaunchUrl());
    const first = await env.app.inject({ method: 'GET', url: url.pathname + url.search, headers: { host: env.host } });
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe('/');
    const setCookie = String(first.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).not.toMatch(/Domain=/i);
    const second = await env.app.inject({ method: 'GET', url: url.pathname + url.search, headers: { host: env.host } });
    expect(second.statusCode).toBe(401);
    expect(second.headers['set-cookie']).toBeUndefined();
  });

  it('invalid and expired nonces are rejected', async () => {
    expect((await env.app.inject({ method: 'GET', url: '/launch?k=nope', headers: { host: env.host } })).statusCode).toBe(401);
    expect((await env.app.inject({ method: 'GET', url: '/launch', headers: { host: env.host } })).statusCode).toBe(401);
    const n = env.auth.createLaunchNonce(Date.now() - NONCE_TTL_MS - 1000);
    expect((await env.app.inject({ method: 'GET', url: `/launch?k=${n}`, headers: { host: env.host } })).statusCode).toBe(401);
  });

  it('a valid cookie unlocks REST and WebSocket; wrong cookies do not', async () => {
    const token = await login();
    const ok = await env.app.inject({ method: 'GET', url: '/api/projects', headers: { ...base(), cookie: `${COOKIE_NAME}=${token}` } });
    expect(ok.statusCode).toBe(200);
    const st = await env.app.inject({ method: 'GET', url: '/api/auth/status', headers: { host: env.host, cookie: `${COOKIE_NAME}=${token}` } });
    expect(st.json().authenticated).toBe(true);
    for (const bad of [`${COOKIE_NAME}=${'0'.repeat(64)}`, `${COOKIE_NAME}=garbage`, `other=${token}`]) {
      expect((await env.app.inject({ method: 'GET', url: '/api/projects', headers: { ...base(), cookie: bad } })).statusCode).toBe(401);
    }
    const ws = await new Promise<string>((resolve) => {
      const s = new WebSocket(`ws://127.0.0.1:${env.port}/ws`, { origin: env.origin, headers: { cookie: `${COOKIE_NAME}=${token}` } });
      s.on('message', (d) => (resolve(`open:${JSON.parse(String(d)).type}`), s.close()));
      s.on('unexpected-response', (req, res) => (resolve(`rejected:${res.statusCode}`), req.destroy()));
    });
    expect(ws).toBe('open:hello');
  });

  it('the CSRF header and origin checks still apply after login', async () => {
    const token = await login();
    const noHeader = await env.app.inject({ method: 'POST', url: '/api/backups', headers: { host: env.host, origin: env.origin, cookie: `${COOKIE_NAME}=${token}` } });
    expect(noHeader.statusCode).toBe(403);
    const foreign = await env.app.inject({ method: 'GET', url: '/api/projects', headers: { host: env.host, origin: 'http://evil.example', cookie: `${COOKIE_NAME}=${token}` } });
    expect(foreign.statusCode).toBe(403);
  });

  it('logout revokes the session', async () => {
    const token = await login();
    const out = await env.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...base(), cookie: `${COOKIE_NAME}=${token}` } });
    expect(out.statusCode).toBe(200);
    expect(String(out.headers['set-cookie'])).toMatch(/Max-Age=0/);
    expect((await env.app.inject({ method: 'GET', url: '/api/projects', headers: { ...base(), cookie: `${COOKIE_NAME}=${token}` } })).statusCode).toBe(401);
  });

  it('expired sessions stop working', async () => {
    const token = env.auth.issueSession(Date.now() - 31 * 24 * 3600_000);
    expect(env.auth.verify(token)).toBe(false);
    expect((await env.app.inject({ method: 'GET', url: '/api/projects', headers: { ...base(), cookie: `${COOKIE_NAME}=${token}` } })).statusCode).toBe(401);
  });

  it('session tokens are stored only as hashes', async () => {
    const token = await login();
    expect(dirDump(env.dataDir)).not.toContain(token);
    expect(JSON.stringify(env.db.prepare('SELECT * FROM auth_sessions').all())).not.toContain(token);
  });

  it('launch-nonce endpoint needs the hook token and rejects browsers', async () => {
    const noTok = await env.app.inject({ method: 'POST', url: '/api/auth/launch-nonce', headers: { host: env.host } });
    expect(noTok.statusCode).toBe(401);
    const browser = await env.app.inject({ method: 'POST', url: '/api/auth/launch-nonce', headers: { host: env.host, origin: env.origin, 'x-qavo-token': env.token } });
    expect(browser.statusCode).toBe(403);
    const ok = await env.app.inject({ method: 'POST', url: '/api/auth/launch-nonce', headers: { host: env.host, 'x-qavo-token': env.token } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${env.port}/launch\\?k=[a-f0-9]{48}$`));
  });

  it('hook and status-line ingestion do not need a cookie (token only)', async () => {
    const r = await env.app.inject({
      method: 'POST',
      url: '/api/hooks',
      headers: { host: env.host, 'x-qavo-token': env.token, 'content-type': 'application/json' },
      payload: { v: 1, eventId: crypto.randomUUID(), ts: new Date().toISOString(), sessionId: 'auth-s', event: 'SessionStart', source: 'startup', projectId: null, folderKeys: [] },
    });
    expect(r.statusCode).toBe(204);
  });
});
