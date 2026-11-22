import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp, type AppHandle } from '../src/app.ts';
import { bootstrapDataDir } from '../src/dataDir.ts';
import { assertNotRealDataDir, resetDemoFiles, seedDemo } from '../src/demo.ts';
import { openDb, type DB } from '../src/db/index.ts';
import * as qa from '../src/qa.ts';
import { makeEnv } from './helpers.ts';

let root: string;
let dir: string;
let db: DB;
let handle: AppHandle;
let settingsPath: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qavo-demo-'));
  dir = path.join(root, 'QA Virtual Office Demo');
  const { paths, token } = bootstrapDataDir(dir, { applyAcl: false });
  db = openDb(paths.db);
  seedDemo(db, dir);
  settingsPath = path.join(root, 'claude', 'settings.json');
  handle = await buildApp({ db, paths, token, port: 47999, logFile: null, webDist: path.join(root, 'no-web'), claudeSettingsPath: settingsPath, authRequired: false, demo: true });
});
afterEach(async () => {
  await handle.app.close();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('demo data', () => {
  it('shows every robot status family through the real status machine (not hard-coded)', () => {
    const rows = db.prepare('SELECT status, COUNT(*) AS c FROM sessions GROUP BY status').all() as Array<{ status: string; c: number }>;
    const statuses = new Set(rows.map((r) => r.status));
    for (const s of ['analyzing', 'writing_tests', 'executing_tests', 'debugging', 'awaiting_permission', 'awaiting_input', 'completed', 'failed', 'disconnected']) {
      expect(statuses.has(s), `status ${s}`).toBe(true);
    }
    expect((db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c).toBe(9);
    expect((db.prepare('SELECT COUNT(*) AS c FROM subagents').get() as { c: number }).c).toBeGreaterThan(0);
  });

  it('fills the whole Manual QA department through the real services, with believable figures', () => {
    const s = qa.qaSummary(db);
    expect(s.requirements).toBe(5);
    expect(s.testCases).toBeGreaterThanOrEqual(6);
    expect(s.testCasesAwaitingReview).toBe(1);
    expect(s.execution).toMatchObject({ passed: 2, failed: 1, approvedTestCases: 4 });
    expect(s.execution.passRate).toMatchObject({ numerator: 2, denominator: 3 });
    expect(s.defects).toMatchObject({ total: 3, open: 2 });
    expect(s.tasks.total).toBe(4);
    expect(s.tasks.blocked).toBe(1);
    // the agent-reported and agent-drafted items exist, and nothing was approved/closed by an agent
    expect((db.prepare("SELECT COUNT(*) AS c FROM test_cases WHERE authored_by = 'agent' AND status = 'draft'").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS c FROM defects WHERE closed_by IS NOT NULL AND closed_by <> 'human'").get() as { c: number }).c).toBe(0);
  });

  it('everything is fictional and inside the demo folder: no real path, name or e-mail', () => {
    const paths = db.prepare('SELECT path_entered FROM project_paths').all() as Array<{ path_entered: string }>;
    expect(paths).toHaveLength(2);
    for (const p of paths) expect(p.path_entered.toLowerCase().startsWith(dir.toLowerCase())).toBe(true);
    const dump = [
      ...db.prepare('SELECT alias FROM projects').all(),
      ...db.prepare('SELECT title, text FROM requirements').all(),
      ...db.prepare('SELECT title FROM test_cases').all(),
      ...db.prepare('SELECT title FROM defects').all(),
    ]
      .map((r) => JSON.stringify(r))
      .join(' ');
    expect(dump).not.toContain(os.userInfo().username);
    expect(dump).not.toMatch(/@/);
  });
});

describe('demo server', () => {
  it('announces demo mode', async () => {
    const hdr = { host: '127.0.0.1:47999' };
    const r = await handle.app.inject({ method: 'GET', url: '/api/demo', headers: hdr });
    expect(r.json()).toMatchObject({ demo: true });
    expect(r.json().banner).toContain('DEMO DATA');
    expect((await handle.app.inject({ method: 'GET', url: '/api/health', headers: hdr })).json()).toMatchObject({ demo: true });
  });

  it('refuses to install or remove Claude Code hooks or the status line, and never creates a settings file', async () => {
    const headers = { host: '127.0.0.1:47999', origin: 'http://127.0.0.1:47999', 'x-qavo-client': '1' };
    for (const url of ['/api/integration/hooks/install', '/api/integration/hooks/uninstall', '/api/integration/statusline/install', '/api/integration/statusline/uninstall']) {
      const r = await handle.app.inject({ method: 'POST', url, headers, payload: { acknowledge: true } });
      expect(r.statusCode, url).toBe(403);
      expect(r.json().error).toBe('demo_mode');
    }
    expect(fs.existsSync(settingsPath)).toBe(false);
  });
});

describe('safety rails', () => {
  it('a normal server is not in demo mode', async () => {
    const env = await makeEnv();
    try {
      expect((await env.app.inject({ method: 'GET', url: '/api/demo', headers: { host: env.host } })).json()).toEqual({ demo: false, banner: '' });
    } finally {
      await env.cleanup();
    }
  });
  it('demo mode refuses the real data directory', () => {
    expect(() => assertNotRealDataDir('C:\\Users\\x\\AppData\\Local\\QA Virtual Office', 'c:\\users\\x\\appdata\\local\\qa virtual office\\')).toThrow(/real data directory/);
    expect(() => assertNotRealDataDir(dir, path.join(root, 'QA Virtual Office'))).not.toThrow();
  });
  it('resetting removes only demo files and leaves other files in the folder alone', () => {
    db.close(); // Windows will not delete an open database file
    fs.writeFileSync(path.join(dir, 'token-keep.txt'), 'keep');
    fs.mkdirSync(path.join(dir, 'demo-projects', 'x'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
    resetDemoFiles(dir);
    expect(fs.existsSync(path.join(dir, 'token-keep.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'demo-projects'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'evidence'))).toBe(false);
  });
});
