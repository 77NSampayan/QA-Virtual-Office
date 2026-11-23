/**
 * Demo mode in a real browser (headless Edge): a permanent DEMO DATA marker, a busy office from real
 * synthetic events, real KPI figures, and a normal server showing none of it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { makeEnv, type TestEnv } from '../apps/server/test/helpers.ts';

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
let demo: TestEnv;
let normal: TestEnv;
let browser: Browser;

beforeAll(async () => {
  expect(fs.existsSync(path.join(ROOT, 'apps/web/dist/index.html')), 'run `npm run build:web` first').toBe(true);
  const webDist = path.join(ROOT, 'apps/web/dist');
  demo = await makeEnv({ listen: true, auth: true, webDist, demo: true });
  normal = await makeEnv({ listen: true, auth: true, webDist });
  browser = await chromium.launch({ executablePath: EDGE, headless: true });
});
afterAll(async () => {
  await browser?.close();
  await demo.cleanup();
  await normal.cleanup();
});

describe('demo mode UI', () => {
  it('shows the DEMO DATA pill and banner on every page, a busy office and real KPI numbers', async () => {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await page.goto(demo.createLaunchUrl());
    await page.waitForSelector('[data-page="overview"]');
    await page.waitForSelector('[data-demo-pill]');
    expect(await page.textContent('[data-demo-pill]')).toContain('DEMO DATA');
    expect(await page.textContent('[data-demo-banner]')).toContain('Nothing here comes from Claude Code');
    expect(await page.title()).toContain('DEMO');
    // the walkable office (default view): every demo robot is placed according to its real status
    await page.waitForSelector('[data-office-robots] li[data-name="Nova"]', { state: 'attached' });
    expect(await page.locator('[data-office-robots] li').count()).toBeGreaterThanOrEqual(11);
    for (const status of ['awaiting_permission', 'failed', 'executing_tests', 'debugging', 'completed', 'disconnected']) {
      expect(await page.locator(`[data-office-robots] li[data-status="${status}"]`).count(), status).toBeGreaterThan(0);
    }
    expect(await page.locator('[data-office-robots] li[data-zone="lounge"]').count()).toBeGreaterThanOrEqual(3); // idle and completed robots rest in the lounge
    await page.waitForFunction(() => document.querySelector('[data-kpi="passed"]')?.getAttribute('data-nodata') === 'false');
    expect((await page.textContent('[data-kpi="passed"] .kpi-value'))?.trim()).toBe('2');
    expect((await page.textContent('[data-kpi="defects"] .kpi-value'))?.trim()).toBe('2');
    for (const hash of ['#/manual', '#/tasks', '#/control', '#/settings']) {
      await page.goto(demo.origin + '/' + hash);
      await page.waitForSelector('[data-demo-pill]');
      expect(await page.isVisible('[data-demo-banner]'), hash).toBe(true);
    }
  });

  it('the Install hooks action is refused with a clear message', async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(demo.createLaunchUrl());
    await page.waitForSelector('[data-page="overview"]');
    const r = await page.evaluate(async () => {
      const res = await fetch('/api/integration/hooks/install', { method: 'POST', headers: { 'content-type': 'application/json', 'x-qavo-client': '1' }, body: JSON.stringify({ acknowledge: true }) });
      return { status: res.status, body: await res.json() };
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('demo_mode');
  });

  it('a normal server shows no demo marker and the KPIs stay empty', async () => {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await page.goto(normal.createLaunchUrl());
    await page.waitForSelector('[data-page="overview"]');
    await page.waitForTimeout(500);
    expect(await page.locator('[data-demo-pill], [data-demo-banner]').count()).toBe(0);
    expect(await page.getAttribute('[data-kpi="passed"]', 'data-nodata')).toBe('true');
  });
});
