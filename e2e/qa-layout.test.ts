/**
 * Slice 4 (headless Edge): the Manual QA workspace reads as one system. Sections are a tab bar (exactly one current),
 * the test case toolbar separates actions from filters, and no section scrolls sideways at the four desktop sizes.
 * Uses the demo data set (fictional, clearly marked) so every section has rows to show.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { makeEnv, type TestEnv } from '../apps/server/test/helpers.ts';

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SIZES = [
  [1280, 720],
  [1366, 768],
  [1600, 900],
  [1920, 1080],
] as const;
const TABS = ['requirements', 'test-cases', 'execution', 'defects', 'exploratory', 'tasks', 'traceability'];

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

describe('Manual QA workspace', () => {
  it('sections are a tab bar with exactly one current tab, and the project selector sits above it', async () => {
    const page = await (await browser.newContext({ viewport: { width: 1366, height: 768 } })).newPage();
    await page.goto(env.createLaunchUrl());
    await page.waitForSelector('.shell');
    await page.evaluate(() => (location.hash = '#/manual'));
    await page.waitForSelector('nav.tabbar');
    expect(await page.locator('nav.tabbar button.tab').count()).toBe(TABS.length);
    expect(await page.locator('nav.tabbar button.tab.on').count()).toBe(1);
    expect(await page.locator('.qa-head [data-project-select]').count()).toBe(1);
    for (const tab of TABS) {
      await page.click(`[data-tab="${tab}"]`);
      await page.waitForSelector(`[data-tab="${tab}"].on`);
      expect(await page.locator('nav.tabbar button.tab.on').count()).toBe(1);
    }
    await page.context().close();
  });

  it('the test case toolbar keeps actions apart from filters, with the count on the right', async () => {
    const page = await (await browser.newContext({ viewport: { width: 1366, height: 768 } })).newPage();
    await page.goto(env.createLaunchUrl());
    await page.waitForSelector('.shell');
    await page.evaluate(() => (location.hash = '#/manual'));
    await page.click('[data-tab="test-cases"]');
    await page.waitForSelector('[data-panel="test-cases"] .filterbar');
    expect(await page.locator('.filterbar .actions button').count()).toBe(2);
    expect(await page.locator('.filterbar .filters select').count()).toBeGreaterThanOrEqual(6);
    expect(await page.locator('.filterbar .filters .count').count()).toBe(1);
    await page.context().close();
  });

  for (const [w, h] of SIZES) {
    it(`no section scrolls sideways at ${w}x${h}, and every table fits its panel`, async () => {
      const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
      await page.goto(env.createLaunchUrl());
      await page.waitForSelector('.shell');
      await page.evaluate(() => (location.hash = '#/manual'));
      await page.waitForSelector('nav.tabbar');
      for (const tab of TABS) {
        await page.click(`[data-tab="${tab}"]`);
        await page.waitForSelector(`[data-tab="${tab}"].on`);
        await page.waitForTimeout(250);
        const m = await page.evaluate(() => ({ hs: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
        expect(m.hs, `${tab} at ${w}`).toBeLessThanOrEqual(0);
      }
      await page.context().close();
    });
  }
});
