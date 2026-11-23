import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { bootstrapDataDir } from '../src/dataDir.ts';
import { openDb } from '../src/db/index.ts';
import { csvCell } from '../src/exporter.ts';
import {
  BACKUP_KEEP,
  checkDbFile,
  createBackup,
  integrityCheck,
  listBackups,
  maybeDailyBackup,
  openDbWithRecovery,
  restoreBackup,
  runRetention,
} from '../src/maintenance.ts';
import { RotatingLog } from '../src/rotatingLog.ts';
import { ingest } from '../src/collector.ts';
import { dirDump, makeEnv, uiHeaders, type TestEnv } from './helpers.ts';

const ROOT = path.resolve(__dirname, '../../..');
const BUNDLE = path.join(ROOT, 'apps/forwarder/dist/forward.mjs');
beforeAll(() => {
  execFileSync(process.execPath, [path.join(ROOT, 'apps/forwarder/build.mjs')]);
});

let env: TestEnv;
beforeEach(async () => {
  env = await makeEnv({ listen: true });
});
afterEach(async () => env.cleanup());

const api = async (method: string, url: string, payload?: unknown) => {
  const r = await env.app.inject({ method: method as 'GET', url, headers: uiHeaders(env), payload: payload as object });
  const json = r.headers['content-type']?.toString().includes('json');
  return { status: r.statusCode, body: r.body && json ? r.json() : null, raw: r.body, headers: r.headers };
};

const DAY = 86_400_000;
function seedEvent(sessionId: string, ts: Date, extra: Record<string, unknown> = {}) {
  return ingest(env.db, { v: 1, eventId: crypto.randomUUID(), ts: ts.toISOString(), sessionId, event: 'UserPromptSubmit', projectId: null, folderKeys: [], ...extra }, env.broadcast, 'replay');
}

describe('retention', () => {
  it('clears opted-in content after contentDays, deletes events/sessions/notifications after eventDays', async () => {
    await api('PUT', '/api/settings/privacy', { prompts: true, confirm: true });
    const now = Date.now();
    seedEvent('old-session', new Date(now - 40 * DAY), { content: { prompt: 'old prompt' } });
    seedEvent('mid-session', new Date(now - 10 * DAY), { content: { prompt: 'mid prompt' } });
    seedEvent('new-session', new Date(now - 1 * DAY), { content: { prompt: 'new prompt' } });
    env.db.prepare("INSERT INTO notifications (id, kind, priority, title, body, created_at) VALUES ('n1','k','low','t','b',?), ('n2','k','low','t','b',?)").run(
      new Date(now - 40 * DAY).toISOString(),
      new Date(now - 1 * DAY).toISOString(),
    );
    const r = runRetention(env.db, now);
    expect(r).toMatchObject({ eventsDeleted: 1, sessionsDeleted: 1, notificationsDeleted: 1 });
    expect(r.contentCleared).toBe(2); // old + mid prompts are cleared (the old event is then deleted outright)
    const rows = env.db.prepare('SELECT session_id, content_json FROM agent_events ORDER BY session_id').all() as Array<{ session_id: string; content_json: string | null }>;
    expect(rows.map((x) => x.session_id)).toEqual(['mid-session', 'new-session']);
    expect(rows[0]!.content_json).toBeNull();
    expect(rows[1]!.content_json).toContain('new prompt');
    expect(env.db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE session_id = 'old-session'").get()).toEqual({ c: 0 });
  });

  it('honours configured retention and removes expired auth sessions', async () => {
    await api('PUT', '/api/settings/retention', { eventDays: 5, contentDays: 2 });
    seedEvent('s1', new Date(Date.now() - 6 * DAY));
    env.auth.issueSession(Date.now() - 40 * DAY);
    const r = runRetention(env.db);
    expect(r.eventsDeleted).toBe(1);
    expect(r.authSessionsDeleted).toBe(1);
  });

  it('API: run now + purge of a content kind', async () => {
    await api('PUT', '/api/settings/privacy', { prompts: true, toolInputs: true, confirm: true });
    seedEvent('p1', new Date(), { content: { prompt: 'secret-ish prompt', toolInput: '{"a":1}' } });
    expect((await api('POST', '/api/privacy/purge', { kinds: ['prompt'] })).body.purged).toBe(1);
    const row = env.db.prepare('SELECT content_json FROM agent_events').get() as { content_json: string };
    expect(JSON.parse(row.content_json)).toEqual({ toolInput: '{"a":1}' });
    expect((await api('POST', '/api/privacy/purge', { kinds: 'all' })).body.purged).toBe(1);
    expect(env.db.prepare('SELECT content_json FROM agent_events').get()).toEqual({ content_json: null });
    expect((await api('POST', '/api/privacy/purge', { kinds: ['nope'] })).status).toBe(400);
    expect((await api('POST', '/api/maintenance/retention')).status).toBe(200);
  });
});

describe('backups', () => {
  it('creates verified backups, keeps the newest 7, daily backup is skipped when one is fresh', async () => {
    seedEvent('b1', new Date());
    const first = await createBackup(env.db, env.paths, new Date('2026-11-01T10:00:00Z'));
    expect(checkDbFile(path.join(env.paths.backups, first.name))).toEqual({ ok: true, detail: 'ok' });
    for (let i = 2; i <= 10; i++) await createBackup(env.db, env.paths, new Date(`2026-11-${String(i).padStart(2, '0')}T10:00:00Z`));
    const list = listBackups(env.paths);
    expect(list).toHaveLength(BACKUP_KEEP);
    // a backup is ONE self-contained file: no WAL/SHM sidecars left behind, including for pruned backups
    expect(fs.readdirSync(env.paths.backups).filter((f) => f !== 'claude-settings').sort()).toEqual(list.map((b) => b.name).sort());
    expect(list[0]!.name).toBe('data-20261110-100000.db');
    expect(list.at(-1)!.name).toBe('data-20261104-100000.db');
    expect(await maybeDailyBackup(env.db, env.paths, new Date())).not.toBeNull(); // newest is older than 24 h
    expect(await maybeDailyBackup(env.db, env.paths, new Date())).toBeNull(); // fresh one exists
  });

  it('API: create + list; backups contain the data', async () => {
    seedEvent('b2', new Date());
    const created = await api('POST', '/api/backups');
    expect(created.status).toBe(201);
    const list = (await api('GET', '/api/backups')).body;
    expect(list[0].name).toBe(created.body.name);
    const copy = new Database(path.join(env.paths.backups, created.body.name), { readonly: true });
    expect(copy.prepare('SELECT COUNT(*) AS c FROM agent_events').get()).toEqual({ c: 1 });
    copy.close();
  });

  it('restoreBackup moves the current DB aside and restores a verified backup; rejects bad names', async () => {
    seedEvent('r1', new Date());
    const b = await createBackup(env.db, env.paths);
    seedEvent('r2', new Date());
    env.db.close();
    restoreBackup(env.paths, b.name);
    const restored = new Database(env.paths.db, { readonly: true });
    expect(restored.prepare('SELECT COUNT(*) AS c FROM agent_events').get()).toEqual({ c: 1 });
    restored.close();
    expect(fs.readdirSync(env.paths.root).some((f) => f.startsWith('data.db.before-restore-'))).toBe(true);
    expect(() => restoreBackup(env.paths, '..\\..\\evil.db')).toThrow(/invalid_backup_name/);
    expect(() => restoreBackup(env.paths, 'data-20200101-000000.db')).toThrow(/backup_not_found/);
  });
});

describe('integrity and recovery', () => {
  it('integrity check endpoint reports ok', async () => {
    expect((await api('POST', '/api/integrity/check')).body).toEqual({ ok: true, detail: 'ok' });
    expect(integrityCheck(env.db).ok).toBe(true);
  });

  function freshDir() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qavo-rec-'));
    return { root, ...bootstrapDataDir(path.join(root, 'data'), { applyAcl: false }) };
  }

  describe('a locked or unreadable database is NOT treated as corrupt (data-safety)', () => {
    const errWith = (code: string, message: string) => Object.assign(new Error(message), { code });
    const seed = () => {
      const { root, paths } = freshDir();
      const db = openDbWithRecovery(paths).db;
      db.prepare("INSERT INTO settings (key, value) VALUES ('marker', '\"keep-me\"')").run();
      db.close();
      return { root, paths };
    };
    const noCorruptCopies = (paths: { root: string }) => fs.readdirSync(paths.root).filter((f) => f.startsWith('data.db.corrupt-'));

    it('a permission or busy error is retried, then reported; the database and its backups are left exactly as they were', () => {
      const { root, paths } = seed();
      const before = fs.readFileSync(paths.db);
      let attempts = 0;
      const sleeps: number[] = [];
      for (const code of ['EPERM', 'EBUSY', 'SQLITE_BUSY', 'SQLITE_CANTOPEN', 'SQLITE_IOERR']) {
        attempts = 0;
        expect(() =>
          openDbWithRecovery(paths, {
            open: () => {
              attempts++;
              throw errWith(code, 'EPERM, Permission denied');
            },
            sleep: (ms) => sleeps.push(ms),
            retries: 3,
          }),
        ).toThrow(/Permission denied/);
        expect(attempts, code).toBe(4); // first try + 3 retries
      }
      expect(sleeps.length).toBe(15);
      expect(noCorruptCopies(paths)).toEqual([]);
      expect(fs.readFileSync(paths.db).equals(before)).toBe(true); // not moved, not replaced, not touched
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('a lock that clears is simply waited out: the same database opens, with no recovery', () => {
      const { root, paths } = seed();
      let n = 0;
      const r = openDbWithRecovery(paths, {
        open: (p) => {
          if (n++ < 2) throw errWith('EPERM', 'EPERM, Permission denied');
          return openDb(p);
        },
        sleep: () => undefined,
      });
      expect(r.recovery).toBeNull();
      expect(r.db.prepare("SELECT value FROM settings WHERE key = 'marker'").get()).toEqual({ value: '"keep-me"' });
      expect(noCorruptCopies(paths)).toEqual([]);
      r.db.close();
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('real corruption is still recovered (by code or by message), and only that', () => {
      for (const err of [errWith('SQLITE_CORRUPT', 'database disk image is malformed'), errWith('SQLITE_NOTADB', 'file is not a database')]) {
        const { root, paths } = seed();
        let first = true;
        const r = openDbWithRecovery(paths, {
          open: (p) => {
            if (first) {
              first = false;
              throw err;
            }
            return openDb(p);
          },
          sleep: () => undefined,
        });
        expect(r.recovery).not.toBeNull();
        expect(noCorruptCopies(paths)).toHaveLength(1);
        r.db.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it('a corrupt database is moved aside and the newest valid backup is restored (B6 recovery)', async () => {
    const { root, paths } = freshDir();
    const first = openDbWithRecovery(paths);
    expect(first.recovery).toBeNull();
    first.db.prepare("INSERT INTO settings (key, value) VALUES ('marker', '\"before-corruption\"')").run();
    await createBackup(first.db, paths);
    first.db.close();
    fs.writeFileSync(paths.db, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4096, 0xff)]));
    const second = openDbWithRecovery(paths);
    expect(second.recovery).toMatchObject({ restoredFrom: expect.stringMatching(/^data-\d{8}-\d{6}\.db$/) });
    expect(second.db.prepare("SELECT value FROM settings WHERE key = 'marker'").get()).toEqual({ value: '"before-corruption"' });
    expect(fs.readdirSync(paths.root).some((f) => f.startsWith('data.db.corrupt-'))).toBe(true);
    expect(JSON.parse((second.db.prepare("SELECT value FROM settings WHERE key = 'recovery_notice'").get() as { value: string }).value).restoredFrom).toBeTruthy();
    second.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('with no valid backup, a fresh database is created and the corrupt one is kept', () => {
    const { root, paths } = freshDir();
    fs.writeFileSync(paths.db, 'this is not a database at all, just text. '.repeat(200));
    const r = openDbWithRecovery(paths);
    expect(r.recovery).toMatchObject({ restoredFrom: null });
    expect(r.db.prepare('SELECT COUNT(*) AS c FROM sessions').get()).toEqual({ c: 0 });
    expect(fs.readdirSync(paths.root).filter((f) => f.startsWith('data.db.corrupt-')).length).toBe(1);
    r.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a corrupt backup is skipped in favour of an older valid one', async () => {
    const { root, paths } = freshDir();
    const a = openDbWithRecovery(paths).db;
    a.prepare("INSERT INTO settings (key, value) VALUES ('m', '1')").run();
    await createBackup(a, paths, new Date('2026-11-01T10:00:00Z'));
    await createBackup(a, paths, new Date('2026-11-02T10:00:00Z'));
    a.close();
    fs.writeFileSync(path.join(paths.backups, 'data-20261102-100000.db'), 'garbage');
    fs.writeFileSync(paths.db, 'garbage');
    const r = openDbWithRecovery(paths);
    expect(r.recovery?.restoredFrom).toBe('data-20261101-100000.db');
    r.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('B6: kill -9 during writes', () => {
  it('after SIGKILL the database passes the integrity check and keeps committed events', async () => {
    const dataDir = path.join(env.root, 'crashdata');
    const { paths } = bootstrapDataDir(dataDir, { applyAcl: false });
    const script = path.join(env.root, 'writer.ts');
    fs.writeFileSync(
      script,
      `
import { openDb } from ${JSON.stringify(path.join(ROOT, 'apps/server/src/db/index.ts').replace(/\\/g, '/'))};
import { ingest } from ${JSON.stringify(path.join(ROOT, 'apps/server/src/collector.ts').replace(/\\/g, '/'))};
const db = openDb(${JSON.stringify(paths.db.replace(/\\/g, '/'))});
let i = 0;
console.log('ready');
setInterval(() => {}, 1000);
for (;;) {
  ingest(db, { v: 1, eventId: crypto.randomUUID(), ts: new Date().toISOString(), sessionId: 'crash-' + (i % 5), event: i % 3 ? 'PreToolUse' : 'UserPromptSubmit', toolName: 'Read', projectId: null, folderKeys: [] }, () => {});
  i++;
  if (i % 50 === 0) console.log('progress ' + i);
}
`,
    );
    const tsx = path.join(ROOT, 'node_modules/tsx/dist/cli.mjs');
    const child = spawn(process.execPath, [tsx, script], { stdio: ['ignore', 'pipe', 'inherit'] });
    let progress = 0;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('writer did not make progress')), 20000);
      child.stdout.on('data', (d) => {
        const m = /progress (\d+)/.exec(String(d));
        if (m) progress = Number(m[1]);
        if (progress >= 200) {
          clearTimeout(t);
          resolve();
        }
      });
    });
    child.kill('SIGKILL'); // TerminateProcess on Windows: no cleanup, mid-write
    await new Promise((r) => child.on('close', r));

    const recovered = openDbWithRecovery(paths);
    expect(recovered.recovery).toBeNull(); // quick_check passed: no recovery needed
    expect(integrityCheck(recovered.db)).toEqual({ ok: true, detail: 'ok' });
    const count = (recovered.db.prepare('SELECT COUNT(*) AS c FROM agent_events').get() as { c: number }).c;
    expect(count).toBeGreaterThanOrEqual(150); // everything committed before the kill is there
    // events and sessions are consistent (each event's session exists: one transaction per event)
    expect(recovered.db.prepare('SELECT COUNT(*) AS c FROM agent_events e LEFT JOIN sessions s ON s.session_id = e.session_id WHERE s.session_id IS NULL').get()).toEqual({ c: 0 });
    recovered.db.close();
  }, 60000);
});

describe('log rotation', () => {
  it('rotates by size and keeps at most N files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qavo-log-'));
    const file = path.join(dir, 'x.log');
    const log = new RotatingLog(file, 100, 3);
    for (let i = 0; i < 40; i++) log.write(`line ${String(i).padStart(2, '0')} ${'x'.repeat(20)}\n`);
    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual(['x.log', 'x.log.1', 'x.log.2', 'x.log.3']);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(100);
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toContain('line ');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('B3 + B4: opt-in capture stays redacted; exports and backups carry no canaries', () => {
  const CANARY = {
    secret: 'sk-' + 'ant-api03-OPTINCANARY0123456789abcd',
    github: 'gh' + 'p_' + 'OptInCanaryTokenABCDEFGHIJKLMNOP1234',
    email: 'optin.canary@example.com',
    phone: '+63 917 555 0188',
    card: '4111 1111 1111 1111',
    folder: 'OptInConfidentialClient',
    formula: '=HYPERLINK("http://evil.example","x")',
  };
  const all = Object.values(CANARY).filter((v) => v !== CANARY.formula);

  it('with every toggle on: content is stored redacted; export (JSON+CSV), backup and logs contain no canary', async () => {
    const projectDir = path.join(env.root, CANARY.folder, 'repo');
    fs.mkdirSync(projectDir, { recursive: true });
    await api('POST', '/api/projects', { alias: 'OptIn', path: projectDir });
    await api('PUT', '/api/settings/privacy', { prompts: true, toolInputs: true, toolOutputs: true, notificationText: true, confirm: true });
    const policy = JSON.parse(fs.readFileSync(env.paths.policy, 'utf8'));
    expect(policy.capture).toEqual({ prompts: true, toolInputs: true, toolOutputs: true, notificationText: true });

    const common = { session_id: 'optin-1', cwd: path.join(projectDir, 'src'), transcript_path: path.join(projectDir, 't.jsonl'), permission_mode: 'default' };
    const text = `key ${CANARY.secret} token ${CANARY.github} mail ${CANARY.email} phone ${CANARY.phone} card ${CANARY.card} path ${projectDir}\\src\\a.ts also ${projectDir.replace(/\\/g, '/')}/b.ts`;
    const seq = [
      { hook_event_name: 'SessionStart', source: 'startup' },
      { hook_event_name: 'UserPromptSubmit', prompt: text },
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `curl -H "Authorization: Bearer ${CANARY.secret}" ${CANARY.email}`, password: 'hunter2-optin' }, tool_use_id: 'toolu_1' },
      { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'x' }, tool_response: { stdout: text }, tool_use_id: 'toolu_1' },
      { hook_event_name: 'Notification', notification_type: 'permission_prompt', title: 'Permission', message: `Claude needs ${CANARY.email}` },
      { hook_event_name: 'UserPromptSubmit', prompt: CANARY.formula },
      { hook_event_name: 'Stop' },
    ];
    for (const p of seq) {
      const code = await new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, [BUNDLE], { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, QAVO_DATA_DIR: env.dataDir } });
        child.on('close', resolve);
        child.stdin.end(JSON.stringify({ ...common, ...p }));
      });
      expect(code).toBe(0);
    }
    const rows = env.db.prepare('SELECT content_json FROM agent_events WHERE content_json IS NOT NULL').all() as Array<{ content_json: string }>;
    expect(rows.length).toBe(5); // prompt, toolInput, 2x(toolInput/toolResponse on PostToolUse), notification, formula prompt
    const stored = rows.map((r) => r.content_json).join('\n');
    expect(stored).toContain('[REDACTED:anthropic_key]');
    expect(stored).toContain('[REDACTED:email]');
    expect(stored).toContain('[REDACTED:card_number]');
    expect(stored).toContain('[REDACTED:phone]');
    expect(stored).not.toContain('hunter2-optin');

    const expJson = await api('GET', '/api/export?format=json');
    const expCsv = await api('GET', '/api/export?format=csv');
    expect(expJson.headers['content-disposition']).toMatch(/attachment; filename="qavo-export-\d{8}-\d{6}\.json"/);
    expect(expCsv.headers['content-type']).toMatch(/text\/csv/);
    const backup = await api('POST', '/api/backups');
    const backupBytes = fs.readFileSync(path.join(env.paths.backups, backup.body.name)).toString('latin1');
    const logs = dirDump(env.paths.logs);
    for (const c of all) {
      expect(stored, `db content: ${c}`).not.toContain(c);
      expect(expJson.raw, `export json: ${c}`).not.toContain(c);
      expect(expCsv.raw, `export csv: ${c}`).not.toContain(c);
      expect(logs, `logs: ${c}`).not.toContain(c);
      if (c !== CANARY.folder) expect(backupBytes, `backup: ${c}`).not.toContain(c);
    }
    // exports never include project paths; the manifest states the capture policy
    expect(expJson.raw).not.toContain(CANARY.folder);
    const manifest = JSON.parse(expJson.raw).manifest;
    expect(manifest).toMatchObject({ redaction: 'applied', projectPathsIncluded: false, capturePolicy: { scope: 'registered', capture: { prompts: true }, retention: { eventDays: 30 } } });
    expect(manifest.counts.events).toBe(seq.length);
    // CSV injection: no cell may begin with a formula character (content cells are JSON objects, starting with "{")
    expect(expCsv.raw).not.toMatch(/(^|,)=HYPERLINK/m);
    for (const line of expCsv.raw.trim().split('\r\n').slice(1)) expect(line).not.toMatch(/(^|,)[=+@]/);
    // backups are NOT exports: they contain project_paths by design (documented), but no captured secrets
    expect(backupBytes).toContain(CANARY.folder);

    // turning a toggle off + purging removes stored content
    await api('PUT', '/api/settings/privacy', { prompts: false });
    await api('POST', '/api/privacy/purge', { kinds: ['prompt'] });
    expect(env.db.prepare("SELECT COUNT(*) AS c FROM agent_events WHERE content_json LIKE '%\"prompt\"%'").get()).toEqual({ c: 0 });
  });

  it('server drops content for a toggle that is off even if a client sends it', async () => {
    await env.app.inject({
      method: 'POST',
      url: '/api/hooks',
      headers: { host: env.host, 'x-qavo-token': env.token, 'content-type': 'application/json' },
      payload: { v: 1, eventId: crypto.randomUUID(), ts: new Date().toISOString(), sessionId: 'off-1', event: 'UserPromptSubmit', projectId: null, folderKeys: [], content: { prompt: 'sneaky' } },
    });
    expect(dirDump(env.dataDir)).not.toContain('sneaky');
  });

  it('csvCell neutralizes formulas and quotes correctly', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+cmd')).toBe("'+cmd");
    expect(csvCell('-x')).toBe("'-x");
    expect(csvCell('@sum')).toBe("'@sum");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });
});
