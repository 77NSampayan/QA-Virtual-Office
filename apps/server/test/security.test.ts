import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { makeEnv, hookHeaders, uiHeaders, type TestEnv } from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await makeEnv({ listen: true });
});
afterAll(async () => env.cleanup());

const validEvent = () => ({
  v: 1,
  eventId: crypto.randomUUID(),
  ts: new Date().toISOString(),
  sessionId: 'sec-session-1',
  event: 'SessionStart',
  source: 'startup',
  projectId: null,
  folderKeys: [],
});

describe('A6: request validation', () => {
  it('rejects a foreign Host header (DNS rebinding)', async () => {
    const r = await env.app.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example:80' } });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: 'bad_host' });
  });

  it('accepts localhost and 127.0.0.1 hosts', async () => {
    for (const host of [`127.0.0.1:${env.port}`, `localhost:${env.port}`]) {
      const r = await env.app.inject({ method: 'GET', url: '/api/health', headers: { host } });
      expect(r.statusCode).toBe(200);
    }
  });

  it('hooks endpoint: rejects any Origin header (browser requests)', async () => {
    const r = await env.app.inject({
      method: 'POST',
      url: '/api/hooks',
      headers: { ...hookHeaders(env), origin: env.origin },
      payload: validEvent(),
    });
    expect(r.statusCode).toBe(403);
  });

  it('hooks endpoint: requires the token', async () => {
    const bad = await env.app.inject({
      method: 'POST',
      url: '/api/hooks',
      headers: { ...hookHeaders(env), 'x-qavo-token': 'nope' },
      payload: validEvent(),
    });
    expect(bad.statusCode).toBe(401);
    const missing = await env.app.inject({ method: 'POST', url: '/api/hooks', headers: { host: env.host }, payload: validEvent() });
    expect(missing.statusCode).toBe(401);
  });

  it('hooks endpoint: valid request gets 204 with an EMPTY body', async () => {
    const r = await env.app.inject({ method: 'POST', url: '/api/hooks', headers: hookHeaders(env), payload: validEvent() });
    expect(r.statusCode).toBe(204);
    expect(r.body).toBe('');
  });

  it('hooks endpoint: rejects non-schema payloads and oversize bodies', async () => {
    const r = await env.app.inject({
      method: 'POST',
      url: '/api/hooks',
      headers: hookHeaders(env),
      payload: { ...validEvent(), cwd: 'C:\\leak' },
    });
    expect(r.statusCode).toBe(400);
    const big = await env.app.inject({
      method: 'POST',
      url: '/api/hooks',
      headers: hookHeaders(env),
      payload: JSON.stringify({ ...validEvent(), pad: 'x'.repeat(70 * 1024) }),
    });
    expect(big.statusCode).toBe(413);
  });

  it('UI API: rejects foreign Origin and cross-site fetch metadata', async () => {
    const r = await env.app.inject({ method: 'GET', url: '/api/projects', headers: { host: env.host, origin: 'http://evil.example' } });
    expect(r.statusCode).toBe(403);
    const s = await env.app.inject({ method: 'GET', url: '/api/projects', headers: { host: env.host, 'sec-fetch-site': 'cross-site' } });
    expect(s.statusCode).toBe(403);
  });

  it('UI API: mutations require X-QAVO-Client (CSRF)', async () => {
    const r = await env.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { host: env.host, origin: env.origin },
      payload: { alias: 'x', path: 'C:\\x\\y' },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: 'client_header_required' });
  });

  it('project path endpoint requires X-QAVO-Client even for GET', async () => {
    const r = await env.app.inject({ method: 'GET', url: '/api/projects/abc/path', headers: { host: env.host } });
    expect(r.statusCode).toBe(403);
    const ok = await env.app.inject({ method: 'GET', url: '/api/projects/abc/path', headers: uiHeaders(env) });
    expect(ok.statusCode).toBe(404);
  });

  it('WebSocket requires the app Origin', async () => {
    const attempt = (origin?: string) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${env.port}/ws`, origin ? { origin } : {});
        ws.on('message', (d) => {
          resolve(`open:${JSON.parse(String(d)).type}`);
          ws.close();
        });
        ws.on('unexpected-response', (req, res) => {
          resolve(`rejected:${res.statusCode}`);
          req.destroy();
        });
        ws.on('error', () => resolve('error'));
      });
    expect(await attempt(env.origin)).toBe('open:hello');
    expect(await attempt('http://evil.example')).toBe('rejected:403');
    expect(await attempt(undefined)).toBe('rejected:403');
  });

  it('sets security headers', async () => {
    const r = await env.app.inject({ method: 'GET', url: '/api/health', headers: { host: env.host } });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['cache-control']).toBe('no-store');
    const html = await env.app.inject({ method: 'GET', url: '/', headers: { host: env.host } });
    expect(String(html.headers['content-security-policy'])).toContain("default-src 'self'");
  });
});
