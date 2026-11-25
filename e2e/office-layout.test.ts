/**
 * Slice 2 (headless Edge): the office comes first and fits the screen at the four desktop sizes; the live strip and the
 * session list show real sessions only; the camera frames what is in use; the panel can be hidden and remembers it.
 * Isolated database, no demo data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { makeEnv, uiHeaders, type TestEnv } from '../apps/server/test/helpers.ts';

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SIZES = [
  [1280, 720],
  [1366, 768],
  [1600, 900],
  [1920, 1080],
] as const;

let env: TestEnv;
let browser: Browser;
let projectId: string;
const cookie = () => `qavo_session=${env.auth.issueSession()}`;

async function post(sessionId: string, event: string, extra: Record<string, unknown> = {}) {
  const r = await env.app.inject({
    method: 'POST',
    url: '/api/hooks',
    headers: { host: env.host, 'x-qavo-token': env.token, 'content-type': 'application/json' },
    payload: { v: 1, eventId: crypto.randomUUID(), ts: new Date().toISOString(), sessionId, event, projectId, folderKeys: [], ...extra },
  });
  expect(r.statusCode).toBe(204);
}
const open = async (w: number, h: number): Promise<Page> => {
  const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
  await page.goto(env.createLaunchUrl());
  await page.waitForSelector('[data-office]');
  return page;
};
const zoomOf = (p: Page) => p.evaluate(() => Number((document.querySelector('.office-canvas-wrap') as HTMLElement).dataset.zoom));
const counts = (p: Page) => p.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-live]')].map((e) => [e.getAttribute('data-live')!, Number(e.querySelector('strong')!.textContent)])));

beforeAll(async () => {
  expect(fs.existsSync(path.join(ROOT, 'apps/web/dist/index.html')), 'run `npm run build:web` first').toBe(true);
  env = await makeEnv({ listen: true, auth: true, webDist: path.join(ROOT, 'apps/web/dist') });
  const dir = path.join(env.root, 'Shop');
  fs.mkdirSync(dir);
  const r = await env.app.inject({ method: 'POST', url: '/api/projects', headers: { ...uiHeaders(env), cookie: cookie() }, payload: { alias: 'Shop', path: dir } });
  projectId = r.json().project.id;
  browser = await chromium.launch({ executablePath: EDGE, headless: true });
});
afterAll(async () => {
  await browser?.close();
  await env.cleanup();
});

describe('the office first, at every desktop size', () => {
  for (const [w, h] of SIZES) {
    it(`at ${w}x${h} the whole office canvas is on screen without scrolling, and the page does not scroll sideways`, async () => {
      const p = await open(w, h);
      await p.waitForTimeout(400);
      const m = await p.evaluate(() => {
        const r = (document.querySelector('.office-canvas-wrap') as HTMLElement).getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, h: r.height, hs: document.documentElement.scrollWidth - document.documentElement.clientWidth, ih: innerHeight };
      });
      expect(m.top, 'starts near the top').toBeLessThan(h * 0.3);
      expect(m.bottom, `canvas bottom ${m.bottom} within ${m.ih}`).toBeLessThanOrEqual(m.ih);
      expect(m.h).toBeGreaterThanOrEqual(420);
      expect(m.hs).toBeLessThanOrEqual(0);
      await p.context().close();
    });
  }
});

describe('real sessions only: nothing, then one', () => {
  it('with no session the strip reads zero and the list explains how to connect; the whole building shows', async () => {
    const p = await open(1366, 768);
    expect(await counts(p)).toEqual({ active: 0, working: 0, waiting: 0, idle: 0, failed: 0 });
    await p.waitForSelector('[data-session-empty]');
    expect(await p.locator('[data-session-row]').count()).toBe(0);
    expect(await p.locator('[data-office-robots] li').count()).toBe(0);
    await p.context().close();
  });

  it('one running session shows once in the strip and the list, and the camera frames what is in use', async () => {
    const p = await open(1366, 768);
    await p.waitForTimeout(2700);
    await post('s-one', 'SessionStart', { source: 'startup' });
    await post('s-one', 'UserPromptSubmit');
    await p.waitForSelector('[data-session-row]');
    const c = await counts(p);
    expect(c.active).toBe(1);
    expect(c.working).toBe(1);
    expect(c.waiting).toBe(0);
    expect(await p.locator('[data-session-row]').count()).toBe(1);
    expect(await p.locator('[data-office-robots] li').count()).toBe(1);
    await p.waitForFunction(() => document.querySelector('[data-office-robots] li')?.getAttribute('data-zone') === 'desk', undefined, { timeout: 30_000 });
    await p.click('[data-office-fit]');
    const whole = await zoomOf(p);
    await p.click('[data-office-focus]');
    const focused = await zoomOf(p);
    expect(focused, 'focus frames fewer rooms, so it is closer than the whole building').toBeGreaterThan(whole);
    // choosing the session in the list selects and follows its robot
    await p.click('[data-session-row]');
    await p.waitForSelector('[data-office-card]');
    const id = await p.getAttribute('[data-session-row]', 'data-session-row');
    expect(await p.evaluate(() => (document.querySelector('.office-canvas-wrap') as HTMLElement).dataset.following)).toBe(id);
    await p.context().close();
  });
});

describe('the session panel', () => {
  it('can be hidden, gives the canvas the full width, and the choice is remembered', async () => {
    const p = await open(1600, 900);
    const width = () => p.evaluate(() => (document.querySelector('.office-canvas-wrap') as HTMLElement).getBoundingClientRect().width);
    const withPanel = await width();
    await p.click('[data-office-panel-toggle]');
    await p.waitForFunction(() => !document.querySelector('[data-session-panel]'));
    await p.waitForTimeout(200);
    expect(await width()).toBeGreaterThan(withPanel + 200);
    await p.reload();
    await p.waitForSelector('[data-office]');
    expect(await p.locator('[data-session-panel]').count()).toBe(0);
    await p.click('[data-office-panel-toggle]');
    await p.waitForSelector('[data-session-panel]');
    await p.context().close();
  });
});
