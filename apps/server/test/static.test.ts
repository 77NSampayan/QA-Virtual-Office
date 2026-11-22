import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
let dist: string;

beforeEach(async () => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'qavo-dist-'));
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>App</title><div id="root"></div>');
  fs.writeFileSync(path.join(dist, 'assets', 'first.js'), 'export const first = 1;');
  env = await makeEnv({ listen: true, webDist: dist });
});
afterEach(async () => {
  await env.cleanup();
  fs.rmSync(dist, { recursive: true, force: true });
});

const get = (url: string) => env.app.inject({ method: 'GET', url, headers: { host: env.host } });

describe('static web UI', () => {
  it('serves index.html at / and for client-side routes', async () => {
    for (const url of ['/', '/projects/abc', '/anything/else']) {
      const r = await get(url);
      expect(r.statusCode, url).toBe(200);
      expect(String(r.headers['content-type'])).toContain('text/html');
      expect(r.body).toContain('id="root"');
    }
  });

  it('serves assets that exist at startup with the right content type', async () => {
    const r = await get('/assets/first.js');
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['content-type'])).toMatch(/javascript/);
  });

  it('REGRESSION: serves assets added AFTER the server started (a rebuilt web UI with new hashed file names)', async () => {
    fs.writeFileSync(path.join(dist, 'assets', 'index-NEWHASH.js'), 'export const rebuilt = true;');
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><script type="module" src="/assets/index-NEWHASH.js"></script>');
    const js = await get('/assets/index-NEWHASH.js');
    expect(js.statusCode).toBe(200);
    expect(String(js.headers['content-type'])).toMatch(/javascript/);
    expect(js.body).toContain('rebuilt');
    expect((await get('/')).body).toContain('index-NEWHASH.js');
  });

  it('a missing file returns 404, never the HTML page (which browsers reject as a module with a MIME error)', async () => {
    for (const url of ['/assets/missing.js', '/assets/missing.css', '/favicon.ico', '/x/y/z.png']) {
      const r = await get(url);
      expect(r.statusCode, url).toBe(404);
      expect(String(r.headers['content-type'])).not.toContain('text/html');
    }
  });

  it('unknown API routes are JSON 404s, not the web page', async () => {
    const r = await env.app.inject({ method: 'GET', url: '/api/nope', headers: { host: env.host } });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: 'not_found' });
  });

  it('path traversal cannot escape the web root', async () => {
    fs.writeFileSync(path.join(path.dirname(dist), 'qavo-secret.txt'), 'SECRET');
    for (const url of ['/../qavo-secret.txt', '/%2e%2e/qavo-secret.txt', '/assets/../../qavo-secret.txt', '/..%5cqavo-secret.txt']) {
      const r = await get(url);
      expect(r.body, url).not.toContain('SECRET');
    }
    fs.rmSync(path.join(path.dirname(dist), 'qavo-secret.txt'), { force: true });
  });
});
