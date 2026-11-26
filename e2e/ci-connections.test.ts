/** Pass 3 A3a (headless Edge): connect a project to GitHub Actions / Azure DevOps (read-only), test, replace the token, disconnect. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createMemoryStore } from '../apps/server/src/secretStore.ts';
import { makeEnv, uiHeaders, type TestEnv } from '../apps/server/test/helpers.ts';

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const GH_TOKEN = 'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789';
const AZ_TOKEN = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst';

let env: TestEnv;
let browser: Browser;
let page: Page;
let pid: string;
let cookie: string;
const secrets = createMemoryStore();
const calls: string[] = [];
let ghStatus = 200;

const fakeFetch = (async (url: string) => {
  calls.push(String(url));
  const u = new URL(String(url));
  if (u.hostname === 'api.github.com') {
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    const run = (id: number, extra: Record<string, unknown> = {}) => ({
      id,
      name: 'CI',
      display_title: 'Fix login for maria.santos@gmail.com',
      head_branch: 'main',
      head_sha: 'abcdef0123456789abcdef0123456789abcdef01',
      status: 'completed',
      conclusion: 'success',
      run_started_at: ago(30),
      updated_at: ago(25),
      html_url: `https://github.com/octo-org/shop-web/actions/runs/${id}`,
      actor: { login: 'maria-santos' },
      head_commit: { message: 'Secret commit message', author: { name: 'Juan dela Cruz' } },
      ...extra,
    });
    return new Response(JSON.stringify(ghStatus === 200 ? { workflow_runs: [run(1), run(2, { conclusion: 'failure', name: 'Deploy' })] } : { message: 'Bad credentials' }), { status: ghStatus, headers: { 'content-type': 'application/json' } });
  }
  if (u.hostname === 'dev.azure.com') return new Response(JSON.stringify({ value: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  throw new Error('unexpected host ' + u.hostname);
}) as unknown as typeof fetch;

beforeAll(async () => {
  expect(fs.existsSync(path.join(ROOT, 'apps/web/dist/index.html')), 'run `npm run build:web` first').toBe(true);
  env = await makeEnv({ listen: true, auth: true, webDist: path.join(ROOT, 'apps/web/dist'), ci: { secrets, fetch: fakeFetch } });
  cookie = `qavo_session=${env.auth.issueSession()}`;
  const dir = path.join(env.root, 'Shop');
  fs.mkdirSync(dir);
  pid = (await env.app.inject({ method: 'POST', url: '/api/projects', headers: { ...uiHeaders(env), cookie }, payload: { alias: 'Shop', path: dir } })).json().project.id as string;
  browser = await chromium.launch({ executablePath: EDGE, headless: true });
  page = await (await browser.newContext({ viewport: { width: 1366, height: 768 } })).newPage();
  await page.goto(env.createLaunchUrl());
  await page.waitForSelector('.shell');
  await page.evaluate(() => (location.hash = '#/automation'));
  await page.waitForSelector('[data-ci] [data-ci-connect]');
});
afterAll(async () => {
  await browser?.close();
  await env.cleanup();
});

describe('CI/CD connections', () => {
  it('connects GitHub, tests it, and the token leaves the screen and is never shown again', async () => {
    await page.fill('[data-ci-owner]', 'octo-org');
    await page.fill('[data-ci-name]', 'shop-web');
    await page.fill('[data-ci-token]', GH_TOKEN);
    expect(await page.getAttribute('[data-ci-token]', 'type')).toBe('password');
    await page.click('[data-ci-connect]');
    await page.waitForSelector('[data-ci-connection="github:octo-org/shop-web"] [data-ci-state="ok"]');
    expect(await page.inputValue('[data-ci-token]')).toBe('');
    expect(await page.textContent('[data-ci-connection="github:octo-org/shop-web"]')).toMatch(/GitHub Actions.*octo-org\/shop-web.*Connected/s);
    expect(await page.content()).not.toContain(GH_TOKEN);
    expect(calls).toEqual(['https://api.github.com/repos/octo-org/shop-web/actions/runs?per_page=1']);
    expect(secrets.all()).toEqual([GH_TOKEN]); // in protected storage only
    if (process.env.QAVO_E2E_SHOTS) await page.screenshot({ path: path.join(process.env.QAVO_E2E_SHOTS, 'ci.png') });
  });

  it('shows the right instructions and labels for Azure DevOps and connects it', async () => {
    await page.selectOption('[data-ci-provider]', 'azure_devops');
    expect(await page.textContent('[data-ci-token-help]')).toMatch(/Build: Read/);
    await page.fill('[data-ci-owner]', 'my-org');
    await page.fill('[data-ci-name]', 'Shop Web');
    await page.fill('[data-ci-token]', AZ_TOKEN);
    await page.click('[data-ci-connect]');
    await page.waitForSelector('[data-ci-connection="azure_devops:my-org/Shop Web"] [data-ci-state="ok"]');
    expect(calls[calls.length - 1]).toBe('https://dev.azure.com/my-org/Shop%20Web/_apis/build/builds?%24top=1&api-version=7.1');
    expect(await page.content()).not.toContain(AZ_TOKEN);
  });

  it('refuses a name that could change the address, and a repeated connection', async () => {
    await page.selectOption('[data-ci-provider]', 'github');
    await page.fill('[data-ci-owner]', 'octo-org');
    await page.fill('[data-ci-name]', '../other');
    await page.fill('[data-ci-token]', GH_TOKEN);
    await page.click('[data-ci-connect]');
    await page.waitForSelector('[data-ci] .error');
    expect(await page.textContent('[data-ci] .error')).toMatch(/invalid_target/);
    await page.fill('[data-ci-name]', 'shop-web');
    await page.fill('[data-ci-token]', GH_TOKEN);
    await page.click('[data-ci-connect]');
    await page.waitForFunction(() => /already_connected/.test(document.querySelector('[data-ci] > .error')?.textContent ?? ''));
  });

  it('a rejected token is explained in our own words; replacing the token and testing again works', async () => {
    ghStatus = 401;
    await page.waitForTimeout(3100); // the server limits how often one connection can be tested
    const row = page.locator('[data-ci-connection="github:octo-org/shop-web"]');
    await row.locator('[data-ci-test]').click();
    await row.locator('[data-ci-state="failed"]').waitFor();
    expect(await row.textContent()).toMatch(/rejected the token/);
    expect(await row.textContent()).not.toMatch(/Bad credentials/); // provider text is never shown
    await row.locator('[data-ci-replace]').click();
    await row.locator('[data-ci-new-token]').fill('github_pat_22ZZZZZZZ0abcdefghijklmnopqrstuvwxyz0123456789');
    await row.locator('[data-ci-save-token]').click();
    await row.locator('[data-ci-state="untested"]').waitFor();
    ghStatus = 200;
    await page.waitForTimeout(3100);
    await row.locator('[data-ci-test]').click();
    await row.locator('[data-ci-state="ok"]').waitFor();
    expect(secrets.all()).toContain('github_pat_22ZZZZZZZ0abcdefghijklmnopqrstuvwxyz0123456789');
    expect(secrets.all()).not.toContain(GH_TOKEN);
  });

  it('refreshes the runs: pipeline, branch, status, commit, duration and a provider link; no person, no commit message, no PR title', async () => {
    const row = page.locator('[data-ci-connection="github:octo-org/shop-web"]');
    expect(await row.locator('[data-ci-asof]').textContent()).toMatch(/No runs read yet/);
    await row.locator('[data-ci-refresh]').click();
    await row.locator('[data-ci-run="passed"]').waitFor();
    const text = (await row.textContent()) ?? '';
    expect(text).toMatch(/Passed.*CI.*main.*abcdef0/s);
    expect(text).toMatch(/Failed.*Deploy/s);
    expect(text).toMatch(/Runs as of/);
    expect(await row.locator('[data-ci-run="passed"] a').getAttribute('href')).toBe('https://github.com/octo-org/shop-web/actions/runs/1');
    expect(await row.locator('[data-ci-run="passed"] a').getAttribute('rel')).toMatch(/noopener/);
    const html = await page.content();
    expect(html).not.toMatch(/maria|Juan|Secret commit|gmail|abcdef0123456789/i);
    if (process.env.QAVO_E2E_SHOTS) await page.screenshot({ path: path.join(process.env.QAVO_E2E_SHOTS, 'ci-runs.png') });
  });

  it('when a refresh fails the saved runs stay, marked as of their last good read, with our own explanation', async () => {
    const row = page.locator('[data-ci-connection="github:octo-org/shop-web"]');
    ghStatus = 401;
    await page.waitForTimeout(10_200); // manual refresh is limited to once every 10 seconds
    await row.locator('[data-ci-refresh]').click();
    await row.locator('[data-ci-refresh-error]').waitFor();
    expect(await row.locator('[data-ci-refresh-error]').textContent()).toMatch(/rejected the token.*last successful read/s);
    expect(await row.locator('[data-ci-run]').count()).toBe(2);
    expect(await row.textContent()).not.toMatch(/Bad credentials/);
    ghStatus = 200;
  });

  it('auto-refresh is off until switched on, shows when it stops, and the 5 minute timer asks the server (which enforces the minimum itself)', async () => {
    const row = page.locator('[data-ci-connection="github:octo-org/shop-web"]');
    expect(await row.locator('[data-ci-polling]').isChecked()).toBe(false);
    expect(await row.locator('[data-ci-polling-note]').count()).toBe(0);
    await page.clock.install();
    const polls: Array<{ body: string; status: number }> = [];
    page.on('response', async (res) => {
      if (res.url().endsWith('/refresh') && res.request().method() === 'POST') polls.push({ body: res.request().postData() ?? '', status: res.status() });
    });
    await row.locator('[data-ci-polling]').click();
    await row.locator('[data-ci-polling-note]').waitFor();
    expect(await row.locator('[data-ci-polling-note]').textContent()).toMatch(/stops by itself at/);
    await page.clock.runFor(4 * 60_000);
    expect(polls).toHaveLength(0); // nothing before 5 minutes
    await page.clock.runFor(2 * 60_000);
    await page.waitForFunction(() => true);
    await expect.poll(() => polls.length, { timeout: 5000 }).toBe(1);
    expect(JSON.parse(polls[0]!.body)).toEqual({ polling: true });
    expect(polls[0]!.status).toBe(429); // the server refuses: its own 5 minutes (real time) have not passed
    await row.locator('[data-ci-polling]').click();
    await row.locator('[data-ci-polling-note]').waitFor({ state: 'detached' });
    await page.clock.runFor(10 * 60_000);
    expect(polls).toHaveLength(1); // switched off: no more requests
  });

  it('disconnecting deletes the token and the connection', async () => {
    const before = secrets.size();
    page.once('dialog', (d) => void d.accept());
    await page.locator('[data-ci-connection="azure_devops:my-org/Shop Web"] [data-ci-disconnect]').click();
    await page.waitForSelector('[data-ci-connection="azure_devops:my-org/Shop Web"]', { state: 'detached' });
    expect(secrets.size()).toBe(before - 1);
    expect(secrets.all()).not.toContain(AZ_TOKEN);
  });

  it('only the signed-in person can use it (no cookie, no agent token)', async () => {
    const r = await env.app.inject({ method: 'GET', url: `/api/projects/${pid}/ci/connections`, headers: { ...uiHeaders(env) } });
    expect(r.statusCode).toBe(401);
  });

  it('has no horizontal scroll at phone width', async () => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.reload();
    await page.waitForSelector('[data-ci] [data-ci-connect]');
    const over = await page.evaluate(() => [...document.querySelectorAll('[data-ci] *')].filter((e) => !e.closest('.scroll-x') && e.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 6).map((e) => e.tagName + '.' + e.className + ' ' + (e.textContent ?? '').slice(0, 30)));
    expect(over, over.join(' | ')).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1366, height: 768 });
  });
});
