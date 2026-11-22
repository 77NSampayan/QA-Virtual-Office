/**
 * B5 (browser): cookie auth + cross-origin isolation, exercised in a real Chromium (Microsoft Edge,
 * headless) via playwright-core. The "evil" page is served from ANOTHER PORT ON THE SAME HOST
 * (127.0.0.1), the realistic local threat: same-site, so the SameSite=Strict cookie IS attached to
 * its requests — the Origin check and the absence of CORS headers must still keep data private.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { makeEnv, type TestEnv } from '../apps/server/test/helpers.ts';

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SHOTS = process.env.QAVO_E2E_SHOTS;

let env: TestEnv;
let browser: Browser;
let evil: http.Server;
let evilOrigin: string;

const EVIL_PAGE = (target: string) => `<!doctype html><title>evil</title><script>
const target = ${JSON.stringify(target)};
const result = {};
const attempt = async (name, fn) => { try { result[name] = await fn(); } catch (e) { result[name] = 'blocked:' + (e && e.name); } };
(async () => {
  await attempt('readProjects', async () => (await fetch(target + '/api/projects', { credentials: 'include' })).text());
  await attempt('readWithHeader', async () => (await fetch(target + '/api/projects', { credentials: 'include', headers: { 'x-qavo-client': '1' } })).text());
  await attempt('noCors', async () => { const r = await fetch(target + '/api/projects', { mode: 'no-cors', credentials: 'include' }); return 'opaque:' + r.type + ':' + (await r.text()).length; });
  await attempt('postBackup', async () => { const r = await fetch(target + '/api/backups', { method: 'POST', mode: 'no-cors', credentials: 'include', body: 'x', headers: { 'content-type': 'text/plain' } }); return r.type; });
  await attempt('ws', () => new Promise((resolve, reject) => { const w = new WebSocket(target.replace('http', 'ws') + '/ws'); w.onmessage = () => { w.close(); resolve('OPEN'); }; w.onerror = () => reject(new Error('ws-failed')); w.onclose = () => reject(new Error('ws-closed')); }));
  window.__result = result;
})();
</script>`;

beforeAll(async () => {
  expect(fs.existsSync(path.join(ROOT, 'apps/web/dist/index.html')), 'run `npm run build:web` first').toBe(true);
  env = await makeEnv({ listen: true, auth: true, webDist: path.join(ROOT, 'apps/web/dist') });
  evil = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(EVIL_PAGE(env.origin));
  });
  await new Promise<void>((r) => evil.listen(0, '127.0.0.1', r));
  evilOrigin = `http://127.0.0.1:${(evil.address() as AddressInfo).port}`;
  browser = await chromium.launch({ executablePath: EDGE, headless: true });
});
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => evil.close(() => r()));
  await env.cleanup();
});

async function signedInContext(): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(env.createLaunchUrl());
  await page.waitForSelector('text=Claude Code sessions');
  await page.close();
  return ctx;
}

describe('B5: browser', () => {
  it('without the launch link the dashboard shows no data and explains how to sign in', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(env.origin + '/');
    await page.waitForSelector('text=This browser is not signed in');
    expect(await page.textContent('body')).not.toContain('Claude Code sessions');
    // direct API access from the same browser: 401, no data
    const status = await page.evaluate(async () => (await fetch('/api/projects', { headers: { 'x-qavo-client': '1' } })).status);
    expect(status).toBe(401);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'not-signed-in.png') });
    await ctx.close();
  });

  it('the one-time launch link signs in; the cookie is HttpOnly and the link cannot be reused', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const url = env.createLaunchUrl();
    await page.goto(url);
    await page.waitForSelector('text=Claude Code sessions');
    expect(page.url()).toBe(env.origin + '/'); // redirected, nonce no longer in the address bar
    expect(await page.evaluate(() => document.cookie)).not.toContain('qavo_session'); // HttpOnly
    const cookie = (await ctx.cookies()).find((c) => c.name === 'qavo_session')!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
    const page2 = await (await browser.newContext()).newPage();
    const reuse = await page2.goto(url);
    expect(reuse!.status()).toBe(401);
    expect(await page2.textContent('body')).toContain('invalid, expired or already used');
    await ctx.close();
  });

  it('a signed-in browser sees the console; the Settings screen renders the 1B controls', async () => {
    const ctx = await signedInContext();
    const page = await ctx.newPage();
    await page.goto(env.origin + '/');
    await page.waitForSelector('text=Claude Code sessions');
    expect(await page.textContent('header')).toContain('Pass 1B');
    await page.click('button.tab:has-text("Settings")');
    await page.waitForSelector('text=Claude Code integration');
    for (const text of ['Privacy and monitoring scope', 'Excluded folders', 'Data: retention, backups, export', 'Install hooks', 'Registered projects only']) {
      expect(await page.textContent('body')).toContain(text);
    }
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'settings.png'), fullPage: true });
    await page.click('button.tab:has-text("Console")');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'console.png'), fullPage: true });
    await ctx.close();
  });

  it('a hostile page on another port of the same host cannot read data, mutate state or open the WebSocket', async () => {
    const ctx = await signedInContext(); // the cookie exists and IS sent to same-site requests
    const backupsBefore = fs.readdirSync(env.paths.backups).filter((f) => f.endsWith('.db')).length;
    const page = await ctx.newPage();
    await page.goto(evilOrigin + '/');
    await page.waitForFunction(() => (window as unknown as { __result?: unknown }).__result !== undefined);
    const result = await page.evaluate(() => (window as unknown as { __result: Record<string, string> }).__result);
    expect(result.readProjects).toMatch(/^blocked:/); // no CORS headers: the page cannot read the response
    expect(result.readWithHeader).toMatch(/^blocked:/); // custom header forces a preflight we never answer
    expect(result.noCors).toMatch(/^(blocked:|opaque:opaque:0$)/); // blocked by CORP same-origin, or at worst opaque with zero readable bytes
    expect(result.ws).toMatch(/^blocked:/); // Origin check rejects the upgrade
    // the no-cors POST reached the server but was refused (403/401 path): no backup was created
    expect(fs.readdirSync(env.paths.backups).filter((f) => f.endsWith('.db')).length).toBe(backupsBefore);
    await ctx.close();
  });

  it('signing out revokes the session', async () => {
    const ctx = await signedInContext();
    const page = await ctx.newPage();
    await page.goto(env.origin + '/');
    await page.click('button.tab:has-text("Settings")');
    await page.click('text=Sign out of this browser');
    await page.waitForSelector('text=This browser is not signed in');
    const status = await page.evaluate(async () => (await fetch('/api/projects', { headers: { 'x-qavo-client': '1' } })).status);
    expect(status).toBe(401);
    await ctx.close();
  });
});
