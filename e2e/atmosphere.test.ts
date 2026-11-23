/**
 * V3 in a real browser (headless Edge): day/night, seasonal themes and sounds, controlled from Settings.
 * Preferences are saved only in the browser; sound is off by default and only real events ever play.
 * A stub AudioContext counts what would be played, so the tests need no audio device.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { lightFor } from '../apps/web/src/office/light.ts';
import { themeFor } from '../apps/web/src/office/theme.ts';
import { makeEnv, uiHeaders, type TestEnv } from '../apps/server/test/helpers.ts';

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SHOTS = process.env.QAVO_E2E_SHOTS;

let env: TestEnv;
let browser: Browser;
let projectId: string;
let cookie: string;

const STUB_AUDIO = () => {
  const w = window as unknown as Record<string, unknown>;
  w.__audio = { oscillators: 0, contexts: 0 };
  class FakeAudioContext {
    state = 'running';
    currentTime = 0;
    destination = {};
    constructor() {
      (w.__audio as { contexts: number }).contexts++;
    }
    createGain() {
      return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
    }
    createOscillator() {
      (w.__audio as { oscillators: number }).oscillators++;
      return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} };
    }
    resume() {
      return Promise.resolve();
    }
  }
  w.AudioContext = FakeAudioContext;
};

async function open(prefs?: unknown): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 1000 } });
  await ctx.addInitScript(STUB_AUDIO);
  if (prefs !== undefined) await ctx.addInitScript((p) => localStorage.setItem('qavo.office.prefs', typeof p === 'string' ? p : JSON.stringify(p)), prefs);
  const page = await ctx.newPage();
  await page.goto(env.createLaunchUrl());
  await page.waitForSelector('[data-office]');
  return { ctx, page };
}
const wrap = (page: Page, key: string) => page.evaluate((k) => (document.querySelector('.office-canvas-wrap') as HTMLElement).dataset[k] ?? '', key);
const audio = (page: Page) => page.evaluate(() => (window as unknown as { __audio: { oscillators: number; contexts: number } }).__audio);
const brightness = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector('.office-canvas') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4 * 13) {
      sum += d[i]! * 0.3 + d[i + 1]! * 0.59 + d[i + 2]! * 0.11;
      n++;
    }
    return sum / n;
  });
async function post(sessionId: string, event: string, extra: Record<string, unknown> = {}) {
  const r = await env.app.inject({
    method: 'POST',
    url: '/api/hooks',
    headers: { host: env.host, 'x-qavo-token': env.token, 'content-type': 'application/json' },
    payload: { v: 1, eventId: crypto.randomUUID(), ts: new Date().toISOString(), sessionId, event, projectId, folderKeys: [], ...extra },
  });
  expect(r.statusCode).toBe(204);
}

beforeAll(async () => {
  expect(fs.existsSync(path.join(ROOT, 'apps/web/dist/index.html')), 'run `npm run build:web` first').toBe(true);
  env = await makeEnv({ listen: true, auth: true, webDist: path.join(ROOT, 'apps/web/dist') });
  cookie = `qavo_session=${env.auth.issueSession()}`;
  const dir = path.join(env.root, 'PaymentsWeb');
  fs.mkdirSync(dir);
  projectId = (await env.app.inject({ method: 'POST', url: '/api/projects', headers: { ...uiHeaders(env), cookie }, payload: { alias: 'Payments Web', path: dir } })).json().project.id;
  browser = await chromium.launch({ executablePath: EDGE, headless: true });
});
afterAll(async () => {
  await browser?.close();
  await env.cleanup();
});

describe('defaults', () => {
  it('automatic light and theme (from the viewer\'s own clock and date), and sound OFF', async () => {
    const { ctx, page } = await open();
    const expectedLight = lightFor(new Date(), 'auto');
    expect(Math.abs(Number(await wrap(page, 'darkness')) - expectedLight.darkness)).toBeLessThan(0.05);
    expect(await wrap(page, 'theme')).toBe(themeFor(new Date(), 'auto'));
    expect(await wrap(page, 'sound')).toBe('off');
    expect((await audio(page)).contexts).toBe(0); // no audio context is even created
    await ctx.close();
  });

  it('garbage in storage is ignored and the defaults apply', async () => {
    const { ctx, page } = await open('{"light":"purple","theme":"<script>alert(1)</script>","sound":"yes","volume":99}');
    expect(await wrap(page, 'sound')).toBe('off');
    expect(await wrap(page, 'theme')).toBe(themeFor(new Date(), 'auto'));
    await ctx.close();
  });
});

describe('day and night', () => {
  it('"always night" dims the whole office and "always day" does not (measured on the canvas)', async () => {
    const day = await open({ light: 'day', theme: 'none' });
    expect(await wrap(day.page, 'light')).toBe('day');
    expect(Number(await wrap(day.page, 'darkness'))).toBe(0);
    await day.page.waitForTimeout(600);
    const dayBrightness = await brightness(day.page);
    await day.ctx.close();
    const night = await open({ light: 'night', theme: 'none' });
    expect(await wrap(night.page, 'light')).toBe('night');
    expect(Number(await wrap(night.page, 'darkness'))).toBeCloseTo(0.42, 2);
    await night.page.waitForTimeout(600);
    const nightBrightness = await brightness(night.page);
    expect(nightBrightness).toBeLessThan(dayBrightness * 0.85);
    if (SHOTS) await (await night.page.$('[data-office]'))!.screenshot({ path: path.join(SHOTS, 'v3-night.png') });
    await night.ctx.close();
  });
});

describe('seasonal themes', () => {
  it.each(['christmas', 'halloween', 'none'] as const)('"%s" is applied and visibly changes the office', async (theme) => {
    const none = await open({ light: 'day', theme: 'none' });
    await none.page.waitForTimeout(500);
    const plain = await none.page.evaluate(() => (document.querySelector('.office-canvas') as HTMLCanvasElement).toDataURL());
    await none.ctx.close();
    const { ctx, page } = await open({ light: 'day', theme });
    expect(await wrap(page, 'theme')).toBe(theme);
    await page.waitForTimeout(500);
    const themed = await page.evaluate(() => (document.querySelector('.office-canvas') as HTMLCanvasElement).toDataURL());
    if (theme === 'none') expect(themed.length).toBeGreaterThan(1000);
    else expect(themed).not.toBe(plain);
    if (SHOTS) await (await page.$('[data-office]'))!.screenshot({ path: path.join(SHOTS, 'v3-' + theme + '.png') });
    await ctx.close();
  });

  it('a chosen theme wins over the date', async () => {
    const { ctx, page } = await open({ light: 'auto', theme: 'christmas' });
    expect(await wrap(page, 'theme')).toBe('christmas');
    await ctx.close();
  });
});

describe('Settings controls', () => {
  it('shows Office appearance with sound off, and choices apply to the office and survive a reload', async () => {
    const { ctx, page } = await open();
    await page.goto(env.origin + '/#/settings');
    await page.waitForSelector('[data-office-appearance]');
    expect(await page.isChecked('[data-sound-toggle]')).toBe(false);
    await page.check('[data-light-option="night"]');
    await page.check('[data-theme-option="halloween"]');
    expect(await page.textContent('[data-appearance-now]')).toBe('night');
    await page.goto(env.origin + '/#/');
    await page.waitForSelector('[data-office]');
    expect(await wrap(page, 'light')).toBe('night');
    expect(await wrap(page, 'theme')).toBe('halloween');
    await page.reload();
    await page.waitForSelector('[data-office]');
    expect(await wrap(page, 'light')).toBe('night');
    expect(await wrap(page, 'theme')).toBe('halloween');
    await page.goto(env.origin + '/#/settings');
    await page.waitForSelector('[data-office-appearance]');
    expect(await page.isChecked('[data-light-option="night"]')).toBe(true);
    expect(await page.isChecked('[data-theme-option="halloween"]')).toBe(true);
    await ctx.close();
  });

  it('the Settings page has no horizontal scroll at 360 px', async () => {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(env.createLaunchUrl());
    await page.goto(env.origin + '/#/settings');
    await page.waitForSelector('[data-office-appearance]');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await ctx.close();
  });
});

describe('sounds', () => {
  it('while sound is off nothing plays, however many real events happen', async () => {
    const { ctx, page } = await open({ light: 'day', theme: 'none' });
    await post('s-off', 'SessionStart', { source: 'startup' });
    await post('s-off', 'UserPromptSubmit');
    await post('s-off', 'PermissionRequest', { toolName: 'Bash' });
    await page.waitForSelector('[data-office-robots] li[data-alert="permission"]', { state: 'attached' });
    await post('s-off', 'PostToolUse', { toolName: 'Bash' });
    await post('s-off', 'Stop');
    await page.waitForSelector('[data-office-robots] li[data-status="completed"]', { state: 'attached' });
    await page.waitForTimeout(800);
    expect((await audio(page)).oscillators).toBe(0);
    expect(await wrap(page, 'soundPlays')).toBe('');
    await ctx.close();
  });

  it('with sound on, real events play (arrival, needs-you, finished) and the volume slider can silence it', async () => {
    const { ctx, page } = await open({ light: 'day', theme: 'none', sound: true, volume: 0.5 });
    expect(await wrap(page, 'sound')).toBe('on');
    await page.waitForTimeout(2700); // a robot present at load is not an event; later ones are
    await post('s-on', 'SessionStart', { source: 'startup' });
    await page.waitForFunction(() => Number((document.querySelector('.office-canvas-wrap') as HTMLElement).dataset.soundPlays ?? '0') >= 1, undefined, { timeout: 10_000 }); // arrival ding
    const afterArrival = await audio(page);
    expect(afterArrival.oscillators).toBeGreaterThan(0);
    await post('s-on', 'UserPromptSubmit');
    await post('s-on', 'PermissionRequest', { toolName: 'Bash' });
    await page.waitForFunction(() => Number((document.querySelector('.office-canvas-wrap') as HTMLElement).dataset.soundPlays ?? '0') >= 2, undefined, { timeout: 10_000 }); // alert
    const plays = Number(await wrap(page, 'soundPlays'));
    // no events, no sounds
    await page.waitForTimeout(2500);
    expect(Number(await wrap(page, 'soundPlays'))).toBe(plays);
    // volume zero: the next event is silent
    await page.goto(env.origin + '/#/settings');
    await page.waitForSelector('[data-sound-volume]');
    await page.fill('[data-sound-volume]', '0');
    await page.goto(env.origin + '/#/');
    await page.waitForSelector('[data-office]');
    const before = (await audio(page)).oscillators;
    await post('s-on', 'PostToolUse', { toolName: 'Bash' });
    await post('s-on', 'Stop');
    await page.waitForSelector('[data-office-robots] li[data-status="completed"]', { state: 'attached' });
    await page.waitForTimeout(800);
    expect((await audio(page)).oscillators).toBe(before);
    await ctx.close();
  });

  it('the Settings "Hear" buttons play a sample, and turning the toggle on in Settings applies at once', async () => {
    const { ctx, page } = await open();
    await page.goto(env.origin + '/#/settings');
    await page.waitForSelector('[data-office-appearance]');
    await page.click('[data-test-sound="complete"]');
    expect((await audio(page)).oscillators).toBeGreaterThan(0);
    await page.check('[data-sound-toggle]');
    await page.goto(env.origin + '/#/');
    await page.waitForSelector('[data-office]');
    expect(await wrap(page, 'sound')).toBe('on');
    await ctx.close();
  });
});
