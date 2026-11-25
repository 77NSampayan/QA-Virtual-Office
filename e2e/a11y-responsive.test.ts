/**
 * Slice 5 (headless Edge): keyboard and screen reader basics, page titles, reduced motion, and every screen at five
 * desktop window sizes (no sideways scroll, no console errors). Demo data only (fictional, clearly marked).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { makeEnv, type TestEnv } from '../apps/server/test/helpers.ts';

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SIZES = [
  [1024, 768],
  [1280, 720],
  [1366, 768],
  [1600, 900],
  [1920, 1080],
] as const;
const ROUTES = ['', 'projects', 'control', 'manual', 'tasks', 'team', 'settings', 'notifications', 'sessions', 'sprites', 'automation', 'api-testing', 'test-data', 'metrics'];

let env: TestEnv;
let browser: Browser;

beforeAll(async () => {
  expect(fs.existsSync(path.join(ROOT, 'apps/web/dist/index.html')), 'run `npm run build:web` first').toBe(true);
  env = await makeEnv({ listen: true, auth: true, demo: true, webDist: path.join(ROOT, 'apps/web/dist') });
  browser = await chromium.launch({ executablePath: EDGE, headless: true });
});
afterAll(async () => {
  await browser?.close();
  await env.cleanup();
});

const open = async (w = 1366, h = 768, opts: { reducedMotion?: 'reduce' } = {}): Promise<{ page: Page; errors: string[] }> => {
  const page = await (await browser.newContext({ viewport: { width: w, height: h }, ...opts })).newPage();
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 160)));
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
  await page.goto(env.createLaunchUrl());
  await page.waitForSelector('.shell');
  return { page, errors };
};
const go = async (page: Page, route: string) => {
  await page.evaluate((r) => (location.hash = `#/${r}`), route);
  await page.waitForSelector('.content > *');
  await page.waitForTimeout(200);
};

describe('keyboard and screen reader basics', () => {
  it('the first Tab stop is a skip link that moves focus to the page, and the page is a labelled landmark', async () => {
    const { page } = await open();
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.className)).toContain('skip-link');
    expect(await page.textContent('.skip-link:focus')).toContain('Skip to content');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('main');
    expect(await page.locator('main#main').count()).toBe(1);
    expect(await page.locator('nav[aria-label="Main"]').count()).toBe(1);
    await page.context().close();
  });

  it('exactly one menu link is marked as the current page, and the title names the page', async () => {
    const { page } = await open();
    for (const [route, label] of [['manual', 'Manual QA'], ['team', 'Team'], ['settings', 'Settings'], ['', 'Overview']] as const) {
      await go(page, route);
      expect(await page.locator('a.navlink[aria-current="page"]').count(), route).toBe(1);
      expect(await page.textContent('a.navlink[aria-current="page"]')).toContain(label);
      expect(await page.title()).toContain(`${label} · QA Virtual Office`);
      expect(await page.title()).toContain('DEMO'); // demo mode stays visible in the title
    }
    await page.context().close();
  });

  it('after opening another page the focus moves to the page (not left on the old link)', async () => {
    const { page } = await open();
    await go(page, 'team');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('main');
    await page.context().close();
  });

  it('a polite live region announces sessions that need attention (demo data has some)', async () => {
    const { page } = await open();
    await page.waitForFunction(() => /need/.test(document.querySelector('[data-attention-live]')?.textContent ?? ''));
    expect(await page.getAttribute('[data-attention-live]', 'aria-live')).toBe('polite');
    await page.context().close();
  });

  it('every control that can take focus shows a visible focus ring', async () => {
    const { page } = await open();
    await go(page, 'manual');
    await page.keyboard.press('Tab');
    const seen = new Set<string>(); void seen;
    let checked = 0;
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      const ring = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        const s = getComputedStyle(el);
        return { tag: el.tagName, outline: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2 };
      });
      if (ring.tag === 'BODY') break; // the end of the page's controls
      expect(ring.outline, `${ring.tag} #${i}`).toBe(true);
      seen.add(ring.tag);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(5);
    await page.context().close();
  });
});

describe('reduced motion', () => {
  it('turns off page and loading animations when the person asks for less motion, and keeps them otherwise', async () => {
    const normal = await open();
    await go(normal.page, 'team');
    expect(await normal.page.evaluate(() => getComputedStyle(document.querySelector('.content > .page')!).animationName)).not.toBe('none');
    await normal.page.context().close();
    const calm = await open(1366, 768, { reducedMotion: 'reduce' });
    await go(calm.page, 'team');
    expect(await calm.page.evaluate(() => getComputedStyle(document.querySelector('.content > .page')!).animationName)).toBe('none');
    expect(await calm.page.evaluate(() => getComputedStyle(document.querySelector('.navlink')!).transitionDuration)).toMatch(/^0s$|^0\.0+1?s?/);
    await calm.page.context().close();
  });
});

describe('every screen at five desktop window sizes', () => {
  for (const [w, h] of SIZES) {
    it(`${w}x${h}: no sideways scroll, no console errors, menu and content both usable`, async () => {
      const { page, errors } = await open(w, h);
      for (const route of ROUTES) {
        await go(page, route);
        const m = await page.evaluate(() => ({ hs: document.documentElement.scrollWidth - document.documentElement.clientWidth, nav: !!document.querySelector('.sidenav') && getComputedStyle(document.querySelector('.sidenav')!).visibility !== 'hidden' && document.querySelector('.sidenav')!.getBoundingClientRect().right > 0, cw: (document.querySelector('.content') as HTMLElement).getBoundingClientRect().width }));
        expect(m.hs, `${route} sideways scroll`).toBeLessThanOrEqual(0);
        expect(m.nav, `${route} menu visible`).toBe(true);
        expect(m.cw, `${route} content width`).toBeGreaterThan(560);
      }
      expect(errors, errors.join(' | ')).toEqual([]);
      await page.context().close();
    });
  }
});
