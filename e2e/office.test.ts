/**
 * V1 in a real browser (headless Edge): the walkable office. Robots are placed and MOVE only because of
 * real hook events; the camera pans, zooms and follows; the classic floor is one click away; narrow screens
 * and reduced motion are respected. A hidden list mirrors every robot (zone, position) for assistive tech and tests.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { makeEnv, uiHeaders, type TestEnv } from '../apps/server/test/helpers.ts';

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SHOTS = process.env.QAVO_E2E_SHOTS;

let env: TestEnv;
let browser: Browser;
let page: Page;
let projectId: string;
let cookie: string;

async function post(sessionId: string, event: string, extra: Record<string, unknown> = {}) {
  const r = await env.app.inject({
    method: 'POST',
    url: '/api/hooks',
    headers: { host: env.host, 'x-qavo-token': env.token, 'content-type': 'application/json' },
    payload: { v: 1, eventId: crypto.randomUUID(), ts: new Date().toISOString(), sessionId, event, projectId, folderKeys: [], ...extra },
  });
  expect(r.statusCode).toBe(204);
}
const robotOf = async (sessionId: string): Promise<string> => {
  const r = await env.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}`, headers: { ...uiHeaders(env), cookie } });
  return r.json().robot.id;
};
const li = (id: string) => `[data-office-robots] li[data-robot="${id}"]`;
const zoneOf = (p: Page, id: string) => p.getAttribute(li(id), 'data-zone');
const waitZone = (p: Page, id: string, zone: string, timeout = 40_000) => p.waitForSelector(`${li(id)}[data-zone="${zone}"]`, { state: 'attached', timeout });
const cam = async (p: Page = page) =>
  p.evaluate(() => {
    const el = document.querySelector('.office-canvas-wrap') as HTMLElement;
    return { zoom: Number(el.dataset.zoom), x: Number(el.dataset.camX), y: Number(el.dataset.camY), following: el.dataset.following ?? '', walking: el.dataset.walking };
  });
/** The canvas box, scrolled into view first (the office sits below the KPI tiles). */
const canvasBox = async (p: Page = page) => {
  await p.evaluate(() => document.querySelector('.office-canvas')!.scrollIntoView({ block: 'center' }));
  return (await (await p.$('.office-canvas'))!.boundingBox())!;
};
const shot = async (name: string, p: Page = page) => {
  if (SHOTS) await (await p.$('[data-office]'))!.screenshot({ path: path.join(SHOTS, name) });
};
/** Screen position (page coordinates) of a robot's centre, from the camera and its mirrored world position. */
async function robotScreenPos(p: Page, id: string) {
  return p.evaluate((rid) => {
    const wrap = document.querySelector('.office-canvas-wrap') as HTMLElement;
    const item = document.querySelector(`[data-office-robots] li[data-robot="${rid}"]`) as HTMLElement;
    const rect = (document.querySelector('.office-canvas') as HTMLElement).getBoundingClientRect();
    const zoom = Number(wrap.dataset.zoom);
    const cx = Number(wrap.dataset.camX);
    const cy = Number(wrap.dataset.camY);
    const wx = Number(item.dataset.wx);
    const wy = Number(item.dataset.wy) - 12;
    return { x: rect.left + (wx - cx) * zoom + rect.width / 2, y: rect.top + (wy - cy) * zoom + rect.height / 2 };
  }, id);
}

beforeAll(async () => {
  expect(fs.existsSync(path.join(ROOT, 'apps/web/dist/index.html')), 'run `npm run build:web` first').toBe(true);
  env = await makeEnv({ listen: true, auth: true, webDist: path.join(ROOT, 'apps/web/dist') });
  cookie = `qavo_session=${env.auth.issueSession()}`;
  const dir = path.join(env.root, 'PaymentsWeb');
  fs.mkdirSync(dir);
  projectId = (await env.app.inject({ method: 'POST', url: '/api/projects', headers: { ...uiHeaders(env), cookie }, payload: { alias: 'Payments Web', path: dir } })).json().project.id;
  browser = await chromium.launch({ executablePath: EDGE, headless: true });
  page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
  await page.goto(env.createLaunchUrl());
  await page.waitForSelector('[data-office]');
});
afterAll(async () => {
  await browser?.close();
  await env.cleanup();
});

describe('the office view', () => {
  it('is the default view, draws a real building (not a blank canvas) and shows vacant rooms when empty', async () => {
    expect(await page.getAttribute('[data-view]', 'data-view')).toBe('office');
    await page.waitForTimeout(500);
    const colours = await page.evaluate(() => {
      const c = document.querySelector('.office-canvas') as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      const seen = new Set<number>();
      for (let i = 0; i < d.length; i += 4 * 97) seen.add((d[i]! << 16) | (d[i + 1]! << 8) | d[i + 2]!);
      return seen.size;
    });
    expect(colours).toBeGreaterThan(8);
    expect(await page.locator('[data-office-robots] li').count()).toBe(0);
    await shot('office-empty.png');
  });

  it('a new session arrives through the elevator, then walks to the lounge (idle); working sends it to its desk', async () => {
    await page.waitForTimeout(2700); // robots present within the first moments after page load are placed in place, not walked in
    await post('v1-a', 'SessionStart', { source: 'startup' });
    const id = await robotOf('v1-a');
    await page.waitForSelector(li(id), { state: 'attached' });
    await page.waitForFunction(() => (document.querySelector('.office-canvas-wrap') as HTMLElement).dataset.walking === 'true');
    expect(await zoneOf(page, id)).toBe('walking');
    await waitZone(page, id, 'lounge'); // idle -> lounge
    await post('v1-a', 'UserPromptSubmit');
    await page.waitForSelector(`${li(id)}[data-zone="walking"]`, { state: 'attached' });
    await waitZone(page, id, 'desk');
    expect(await page.getAttribute(li(id), 'data-status')).toBe('analyzing');
    await post('v1-a', 'Stop');
    await waitZone(page, id, 'lounge'); // completed -> lounge
    await shot('office-lounge.png');
  });

  it('waiting for the person and failures stay at the desk; nothing moves without an event', async () => {
    await post('v1-b', 'SessionStart', { source: 'startup' });
    const id = await robotOf('v1-b');
    await post('v1-b', 'UserPromptSubmit');
    await post('v1-b', 'PermissionRequest', { toolName: 'Bash' });
    await page.waitForSelector(`${li(id)}[data-status="awaiting_permission"]`, { state: 'attached' });
    await waitZone(page, id, 'desk');
    await page.waitForFunction(() => (document.querySelector('.office-canvas-wrap') as HTMLElement).dataset.walking === 'false', undefined, { timeout: 60_000 });
    const snap = () => page.evaluate(() => [...document.querySelectorAll('[data-office-robots] li')].map((e) => `${e.getAttribute('data-robot')}:${e.getAttribute('data-zone')}:${e.getAttribute('data-wx')}:${e.getAttribute('data-wy')}`).sort());
    const before = await snap();
    await page.waitForTimeout(3000);
    expect(await snap()).toEqual(before);
    expect((await cam()).walking).toBe('false');
    await shot('office-two.png');
  });

  it('an ended session goes dark at its desk', async () => {
    await post('v1-c', 'SessionStart', { source: 'startup' });
    const id = await robotOf('v1-c');
    await post('v1-c', 'UserPromptSubmit');
    await post('v1-c', 'SessionEnd', { reason: 'other' });
    await page.waitForSelector(`${li(id)}[data-status="disconnected"]`, { state: 'attached' });
    await waitZone(page, id, 'desk');
  });
});

describe('camera', () => {
  it('the wheel zooms around the cursor, buttons zoom, Fit resets, and zoom stays within limits', async () => {
    await page.click('[data-office-fit]');
    const base = await cam();
    const box = await canvasBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400);
    await page.waitForFunction((z) => Number((document.querySelector('.office-canvas-wrap') as HTMLElement).dataset.zoom) > z, base.zoom);
    const zoomed = await cam();
    expect(zoomed.zoom).toBeGreaterThan(base.zoom);
    await page.click('[data-office-zoom-out]');
    expect((await cam()).zoom).toBeLessThan(zoomed.zoom);
    for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 800);
    await page.waitForTimeout(150);
    expect((await cam()).zoom).toBeGreaterThanOrEqual(0.5);
    for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -800);
    await page.waitForTimeout(150);
    expect((await cam()).zoom).toBeLessThanOrEqual(8);
    await page.click('[data-office-fit]');
    expect((await cam()).zoom).toBeCloseTo(base.zoom, 1);
  });

  it('dragging pans the view', async () => {
    await page.click('[data-office-fit]');
    await page.click('[data-office-zoom-in]');
    await page.click('[data-office-zoom-in]');
    const before = await cam();
    const box = await canvasBox();
    await page.mouse.move(box.x + 300, box.y + 300);
    await page.mouse.down();
    await page.mouse.move(box.x + 420, box.y + 340, { steps: 6 });
    await page.mouse.up();
    const after = await cam();
    expect(after.x).toBeLessThan(before.x);
    expect(after.y).toBeLessThan(before.y);
  });

  it('keys work: arrows pan, plus/minus zoom, 0 fits', async () => {
    await page.click('[data-office-fit]');
    await page.focus('.office-canvas');
    const a = await cam();
    await page.keyboard.press('+');
    await page.keyboard.press('+');
    const b = await cam();
    expect(b.zoom).toBeGreaterThan(a.zoom);
    await page.keyboard.press('ArrowLeft');
    const c = await cam();
    expect(c.x).toBeLessThan(b.x); // ArrowLeft looks further left: the view centre moves left
    await page.keyboard.press('-');
    expect((await cam()).zoom).toBeLessThan(b.zoom);
    await page.keyboard.press('0');
    expect((await cam()).zoom).toBeCloseTo(a.zoom, 1);
  });

  it('click selects a robot (details card), double-click follows it, dragging stops following', async () => {
    const id = await robotOf('v1-b');
    await page.click('[data-office-fit]');
    await page.click('[data-office-zoom-in]');
    await page.click('[data-office-zoom-in]');
    await page.click('[data-office-zoom-in]');
    // bring the robot into view first by following, then stop
    await canvasBox();
    const p0 = await robotScreenPos(page, id);
    const box = await canvasBox();
    if (p0.x < box.x || p0.x > box.x + box.width || p0.y < box.y || p0.y > box.y + box.height) {
      await page.click('[data-office-fit]');
    }
    await canvasBox();
    const p = await robotScreenPos(page, id);
    await page.mouse.dblclick(p.x, p.y);
    await page.waitForSelector(`[data-office-card="${id}"]`);
    await page.waitForFunction((rid) => (document.querySelector('.office-canvas-wrap') as HTMLElement).dataset.following === rid, id);
    expect(await page.textContent(`[data-office-card="${id}"]`)).toContain('Awaiting permission');
    await shot('office-follow.png');
    const b = await canvasBox();
    await page.mouse.move(b.x + 200, b.y + 200);
    await page.mouse.down();
    await page.mouse.move(b.x + 260, b.y + 230, { steps: 4 });
    await page.mouse.up();
    expect((await cam()).following).toBe('');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-office-card]'));
  });

  it('Enlarge fills the window and Shrink returns', async () => {
    await page.click('[data-office-enlarge]');
    await page.waitForSelector('.office-big');
    const big = (await (await page.$('.office-big'))!.boundingBox())!;
    expect(big.width).toBeGreaterThan(1200);
    await page.click('[data-office-enlarge]');
    await page.waitForFunction(() => !document.querySelector('.office-big'));
  });
});

describe('V2: life in the office', () => {
  const attr = (id: string, name: string) => page.getAttribute(li(id), name);
  const wrapAttr = (name: string) => page.evaluate((n) => (document.querySelector('.office-canvas-wrap') as HTMLElement).dataset[n] ?? '', name);
  const settle = () => page.waitForFunction(() => (document.querySelector('.office-canvas-wrap') as HTMLElement).dataset.walking === 'false', undefined, { timeout: 60_000 });
  const effectsInclude = (needle: string) => page.waitForFunction((n) => ((document.querySelector('.office-canvas-wrap') as HTMLElement).dataset.effects ?? '').includes(n), needle, { timeout: 5000 });
  const effectsExclude = (needle: string) => page.waitForFunction((n) => !((document.querySelector('.office-canvas-wrap') as HTMLElement).dataset.effects ?? '').includes(n), needle, { timeout: 15_000 });

  it('activity bubbles come from the tool category only, and disappear when the robot stops working', async () => {
    await post('v2-a', 'SessionStart', { source: 'startup' });
    const id = await robotOf('v2-a');
    await post('v2-a', 'UserPromptSubmit');
    await post('v2-a', 'PreToolUse', { toolName: 'Read' });
    await page.waitForSelector(li(id) + '[data-bubble="reading"]', { state: 'attached' });
    await post('v2-a', 'PreToolUse', { toolName: 'Write', fileCategory: 'test' });
    await page.waitForSelector(li(id) + '[data-bubble="writing tests"]', { state: 'attached' });
    await post('v2-a', 'PreToolUse', { toolName: 'Edit', fileCategory: 'source' });
    await page.waitForSelector(li(id) + '[data-bubble="editing code"]', { state: 'attached' });
    await post('v2-a', 'PreToolUse', { toolName: 'Bash', commandCategory: 'test_run' });
    await page.waitForSelector(li(id) + '[data-bubble="running tests"][data-wait="hourglass"]', { state: 'attached' });
    await post('v2-a', 'Stop');
    await page.waitForSelector(li(id) + '[data-status="completed"]', { state: 'attached' });
    expect(await attr(id, 'data-bubble')).toBe('');
    expect(await attr(id, 'data-wait')).toBe('');
  });

  it('a robot that needs the person raises an alert (permission or input) that clears when answered', async () => {
    await post('v2-b', 'SessionStart', { source: 'startup' });
    const id = await robotOf('v2-b');
    await post('v2-b', 'UserPromptSubmit');
    await post('v2-b', 'PermissionRequest', { toolName: 'Bash' });
    await page.waitForSelector(li(id) + '[data-alert="permission"]', { state: 'attached' });
    await post('v2-b', 'PostToolUse', { toolName: 'Bash' });
    await post('v2-b', 'Notification', { notificationType: 'elicitation_dialog' });
    await page.waitForSelector(li(id) + '[data-alert="input"]', { state: 'attached' });
    await post('v2-b', 'UserPromptSubmit');
    await page.waitForSelector(li(id) + '[data-alert=""]', { state: 'attached' });
    expect(await attr(id, 'data-status')).toBe('analyzing'); // working again: its recent tool may show as a bubble, the alert is gone
  });

  it('finishing sets off confetti for a few seconds, a failure brings a rain cloud, and nothing celebrates by itself', async () => {
    await post('v2-c', 'SessionStart', { source: 'startup' });
    const id = await robotOf('v2-c');
    await post('v2-c', 'UserPromptSubmit');
    await page.waitForSelector(li(id) + '[data-status="analyzing"]', { state: 'attached' });
    expect(await wrapAttr('effects')).not.toContain(id);
    await post('v2-c', 'Stop');
    await effectsInclude('confetti:' + id);
    await effectsExclude(id);
    await post('v2-c', 'UserPromptSubmit');
    await post('v2-c', 'StopFailure', { error: 'rate_limit' });
    await effectsInclude('rain:' + id);
    await effectsExclude(id);
  });

  it('a subagent arrives as a drone through the elevator, then hovers beside its robot; the elevator opens for it', async () => {
    await post('v2-d', 'SessionStart', { source: 'startup' });
    const id = await robotOf('v2-d');
    await post('v2-d', 'UserPromptSubmit');
    await page.waitForSelector(li(id) + '[data-status="analyzing"]', { state: 'attached' });
    await settle();
    await post('v2-d', 'SubagentStart', { agentId: 'drone-1', agentType: 'Explore' });
    await page.waitForSelector('[data-office-drones] li[data-parent="' + id + '"][data-state="flying"]', { state: 'attached' });
    await page.waitForFunction(() => (document.querySelector('.office-canvas-wrap') as HTMLElement).dataset.lift === 'open', undefined, { timeout: 3000 });
    await page.waitForSelector('[data-office-drones] li[data-parent="' + id + '"][data-state="hover"]', { state: 'attached', timeout: 20_000 });
    await page.waitForFunction(() => (document.querySelector('.office-canvas-wrap') as HTMLElement).dataset.lift === 'closed', undefined, { timeout: 8000 });
  });

  it('a room door swings open when a robot walks through it and shuts again afterwards', async () => {
    await post('v2-e', 'SessionStart', { source: 'startup' });
    const id = await robotOf('v2-e');
    await waitZone(page, id, 'lounge'); // idle: resting in the lounge
    expect(await wrapAttr('doorsOpen')).toBe('');
    await post('v2-e', 'UserPromptSubmit');
    await page.waitForFunction(() => ((document.querySelector('.office-canvas-wrap') as HTMLElement).dataset.doorsOpen ?? '') !== '', undefined, { timeout: 30_000 });
    await waitZone(page, id, 'desk');
    await page.waitForFunction(() => ((document.querySelector('.office-canvas-wrap') as HTMLElement).dataset.doorsOpen ?? '') === '', undefined, { timeout: 8000 });
    await shot('office-v2.png');
  });

  it('with no events everything is still: no walking, no open doors, no effects', async () => {
    await settle();
    await page.waitForTimeout(16_000); // let every effect and door finish
    await page.waitForFunction(() => {
      const el = document.querySelector('.office-canvas-wrap') as HTMLElement;
      return el.dataset.walking === 'false' && (el.dataset.doorsOpen ?? '') === '' && (el.dataset.effects ?? '') === '';
    });
    const snap = () => page.evaluate(() => [...document.querySelectorAll('[data-office-robots] li, [data-office-drones] li')].map((e) => e.outerHTML).join('|'));
    const before = await snap();
    await page.waitForTimeout(2500);
    expect(await snap()).toBe(before);
  });
});

describe('views, narrow screens and reduced motion', () => {
  it('Classic view switches to the old floor, remembers the choice, and Office view returns', async () => {
    await page.click('[data-office-classic]');
    await page.waitForSelector('[data-view="classic"] [data-floor]');
    await page.reload();
    await page.waitForSelector('[data-view="classic"] [data-floor]');
    await page.click('[data-switch-office]');
    await page.waitForSelector('[data-view="office"] [data-office]');
  });

  it('at 360 px the status cards are shown instead of the canvas (no horizontal scroll)', async () => {
    const p = await (await browser.newContext({ viewport: { width: 360, height: 800 } })).newPage();
    await p.goto(env.createLaunchUrl());
    await p.waitForSelector('[data-view="classic"]');
    expect(await p.locator('[data-office]').count()).toBe(0);
    expect(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });

  it('with reduced motion robots are placed instantly (no walking)', async () => {
    const p = await (await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' })).newPage();
    await p.goto(env.createLaunchUrl());
    await p.waitForSelector('[data-office]');
    await post('v1-d', 'SessionStart', { source: 'startup' });
    const id = await robotOf('v1-d');
    await p.waitForSelector(`${li(id)}[data-zone="lounge"]`, { state: 'attached', timeout: 30_000 });
    await post('v1-d', 'UserPromptSubmit');
    await p.waitForSelector(`${li(id)}[data-zone="desk"]`, { state: 'attached', timeout: 30_000 });
    expect((await cam(p)).walking).toBe('false');
  });
});
