import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { parsePolicy } from '@qavo/shared';
import { folderKeysWithDepth, parseFolderKeySecret } from '@qavo/shared/folderKeys';
import { pathForms } from '@qavo/shared/paths';
import { makeEnv, hookHeaders, uiHeaders, dirDump, type TestEnv } from './helpers.ts';

let env: TestEnv;
let projectDir: string;
const SECRET_FOLDER = 'ZetaClientConfidential';
const SECRET_SUB = 'QuarterlyPayrollTests';

beforeEach(async () => {
  env = await makeEnv({ listen: true });
  projectDir = path.join(env.root, SECRET_FOLDER, SECRET_SUB);
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
});
afterEach(async () => env.cleanup());

const policyOnDisk = () => parsePolicy(fs.readFileSync(env.paths.policy, 'utf8'));

async function api(method: string, url: string, payload?: unknown) {
  const r = await env.app.inject({ method: method as 'GET', url, headers: uiHeaders(env), payload: payload as object });
  return { status: r.statusCode, body: r.body ? r.json() : null, raw: r.body };
}

let seq = 0;
function sanitized(sessionId: string, event: string, extra: Record<string, unknown> = {}) {
  seq++;
  return {
    v: 1,
    eventId: crypto.randomUUID(),
    ts: new Date(Date.UTC(2026, 10, 22, 0, 0, seq)).toISOString(),
    sessionId,
    event,
    projectId: null,
    folderKeys: [],
    ...extra,
  };
}
async function post(ev: unknown) {
  const r = await env.app.inject({ method: 'POST', url: '/api/hooks', headers: hookHeaders(env), payload: ev as object });
  expect(r.statusCode).toBe(204);
}

describe('projects API + capture-policy.json sync (A9)', () => {
  it('register -> policy contains id + forms; ordinary responses carry alias only', async () => {
    const r = await api('POST', '/api/projects', { alias: 'Alpha Web', path: projectDir });
    expect(r.status).toBe(201);
    expect(r.body.project).toMatchObject({ alias: 'Alpha Web', pathConfigured: true, pathStatus: 'ok' });
    expect(r.raw).not.toContain(SECRET_FOLDER);
    const { policy, failClosed } = policyOnDisk();
    expect(failClosed).toBe(false);
    expect(policy.version).toBe(r.body.policyVersion);
    expect(policy.projects).toEqual([{ id: r.body.project.id, ...pathForms(projectDir) }]);
  });

  it('PATCH alias (rename) regenerates the policy, keeps paths', async () => {
    const { body } = await api('POST', '/api/projects', { alias: 'Alpha', path: projectDir });
    const v1 = policyOnDisk().policy.version;
    const r = await api('PATCH', `/api/projects/${body.project.id}`, { alias: 'Alpha Renamed' });
    expect(r.status).toBe(200);
    expect(r.body.project.alias).toBe('Alpha Renamed');
    const { policy } = policyOnDisk();
    expect(policy.version).toBe(v1 + 1);
    expect(policy.projects[0]!.lexical).toBe(pathForms(projectDir).lexical);
  });

  it('PATCH path changes the policy forms', async () => {
    const { body } = await api('POST', '/api/projects', { alias: 'Alpha', path: projectDir });
    const other = path.join(env.root, 'MovedRepo');
    fs.mkdirSync(other);
    const r = await api('PATCH', `/api/projects/${body.project.id}`, { path: other });
    expect(r.status).toBe(200);
    expect(policyOnDisk().policy.projects).toEqual([{ id: body.project.id, ...pathForms(other) }]);
  });

  it('DELETE removes the project from the policy', async () => {
    const { body } = await api('POST', '/api/projects', { alias: 'Alpha', path: projectDir });
    expect((await api('DELETE', `/api/projects/${body.project.id}`)).status).toBe(200);
    expect(policyOnDisk().policy.projects).toEqual([]);
    expect((await api('GET', '/api/projects')).body).toEqual([]);
  });

  it('a corrupt policy file is replaced on regeneration (startup)', async () => {
    await api('POST', '/api/projects', { alias: 'Alpha', path: projectDir });
    fs.writeFileSync(env.paths.policy, '{corrupt');
    expect(policyOnDisk().failClosed).toBe(true);
    env.regeneratePolicy();
    expect(policyOnDisk().failClosed).toBe(false);
    expect(policyOnDisk().policy.projects).toHaveLength(1);
  });

  it('validates input: absolute path, no drive root, unique path, safe alias', async () => {
    expect((await api('POST', '/api/projects', { alias: 'x', path: 'relative\\dir' })).body.error).toBe('path_not_absolute');
    expect((await api('POST', '/api/projects', { alias: 'x', path: 'C:\\' })).body.error).toBe('path_is_root');
    expect((await api('POST', '/api/projects', { alias: 'a/b', path: projectDir })).body.error).toBe('alias_invalid');
    await api('POST', '/api/projects', { alias: 'one', path: projectDir });
    expect((await api('POST', '/api/projects', { alias: 'two', path: projectDir.toUpperCase() + '\\' })).status).toBe(409);
  });

  it('warns when the alias reveals a folder name', async () => {
    const r = await api('POST', '/api/projects', { alias: SECRET_SUB, path: projectDir });
    expect(r.body.warnings).toContain('alias_matches_folder_name');
  });

  it('the path endpoint is the only place the actual path is returned', async () => {
    const { body } = await api('POST', '/api/projects', { alias: 'Alpha', path: projectDir });
    const r = await api('GET', `/api/projects/${body.project.id}/path`);
    expect(r.body.pathEntered).toBe(projectDir);
    expect(r.body.exists).toBe(true);
  });
});

describe('collector', () => {
  it('drives session status from events and records the matrix rule', async () => {
    const { body } = await api('POST', '/api/projects', { alias: 'Alpha', path: projectDir });
    const pid = body.project.id;
    const sid = 'sess-coll-1';
    await post(sanitized(sid, 'SessionStart', { projectId: pid, source: 'startup', model: 'claude-haiku-5-5' }));
    await post(sanitized(sid, 'UserPromptSubmit', { projectId: pid }));
    await post(sanitized(sid, 'PreToolUse', { projectId: pid, toolName: 'Bash', commandCategory: 'test_run' }));
    let s = (await api('GET', `/api/sessions/${sid}`)).body;
    expect(s).toMatchObject({ status: 'executing_tests', statusSource: 'inferred', projectAlias: 'Alpha', model: 'claude-haiku-5-5' });
    await post(sanitized(sid, 'PermissionRequest', { projectId: pid, toolName: 'Bash' }));
    s = (await api('GET', `/api/sessions/${sid}`)).body;
    expect(s).toMatchObject({ status: 'awaiting_permission', statusSource: 'event', pendingPermissionTool: 'Bash' });
    await post(sanitized(sid, 'PostToolUse', { projectId: pid, toolName: 'Bash', commandCategory: 'test_run' }));
    await post(sanitized(sid, 'Stop', { projectId: pid }));
    await post(sanitized(sid, 'SessionEnd', { projectId: pid, reason: 'prompt_input_exit' }));
    s = (await api('GET', `/api/sessions/${sid}`)).body;
    expect(s.status).toBe('disconnected');
    const events = (await api('GET', `/api/sessions/${sid}/events`)).body;
    expect(events.map((e: { rule: string }) => e.rule).reverse()).toEqual(['1', '4', '5', '11', '7', '19', '23']);
    const notes = (await api('GET', '/api/notifications')).body;
    expect(notes.map((n: { kind: string }) => n.kind)).toEqual(['session_completed', 'permission_required']);
    expect(notes[1].body).toContain('Alpha');
  });

  it('row 32: duplicate/replayed events are ignored', async () => {
    const ev = sanitized('sess-dup', 'UserPromptSubmit');
    await post(ev);
    await post(ev);
    expect((await api('GET', '/api/sessions/sess-dup/events')).body).toHaveLength(1);
  });

  it('resume keeps the robot; fork gets a new session and robot (A10)', async () => {
    const { body } = await api('POST', '/api/projects', { alias: 'Alpha', path: projectDir });
    const pid = body.project.id;
    await post(sanitized('s-orig', 'SessionStart', { projectId: pid, source: 'startup' }));
    await post(sanitized('s-orig', 'SessionEnd', { projectId: pid, reason: 'other' }));
    const robot1 = (await api('GET', '/api/sessions/s-orig')).body.robot.id;
    await post(sanitized('s-orig', 'SessionStart', { projectId: pid, source: 'resume' }));
    const resumed = (await api('GET', '/api/sessions/s-orig')).body;
    expect(resumed.robot.id).toBe(robot1);
    expect(resumed.status).toBe('idle');
    await post(sanitized('s-fork', 'SessionStart', { projectId: pid, source: 'fork' }));
    const forked = (await api('GET', '/api/sessions/s-fork')).body;
    expect(forked.origin).toBe('fork');
    expect(forked.parentSessionId).toBeNull(); // nothing inferred
    expect(forked.robot.id).not.toBe(robot1);
  });

  it('events for a deleted/unknown project id are stored unassigned', async () => {
    await post(sanitized('s-x', 'SessionStart', { projectId: 'proj_doesnotexist', source: 'startup' }));
    expect((await api('GET', '/api/sessions/s-x')).body.projectId).toBeNull();
  });

  it('opt-in content is dropped server-side when the policy does not allow it', async () => {
    await post(sanitized('s-c', 'UserPromptSubmit', { content: { prompt: 'should not be stored' } }));
    expect(dirDump(env.dataDir)).not.toContain('should not be stored');
  });
});

describe('A11: path non-leakage + folder keys', () => {
  it('actual path and folder names never appear in events, logs, WS messages or ordinary responses', async () => {
    const wsMessages: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${env.port}/ws`, { origin: env.origin });
    await new Promise((r) => ws.once('message', r));
    ws.on('message', (d) => wsMessages.push(String(d)));

    const created = await api('POST', '/api/projects', { alias: 'Alpha', path: projectDir });
    const pid = created.body.project.id;
    const sid = 'sess-leak';
    for (const e of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'SessionEnd']) {
      await post(sanitized(sid, e, { projectId: pid, toolName: e.includes('Tool') || e === 'PermissionRequest' ? 'Read' : undefined }));
    }
    await api('PATCH', `/api/projects/${pid}`, { alias: 'Alpha 2' });
    const responses = [
      created.raw,
      (await api('GET', '/api/projects')).raw,
      (await api('GET', '/api/sessions')).raw,
      (await api('GET', `/api/sessions/${sid}`)).raw,
      (await api('GET', `/api/sessions/${sid}/events`)).raw,
      (await api('GET', '/api/notifications')).raw,
      (await api('GET', '/api/integration/status')).raw,
      (await api('GET', '/api/health')).raw,
      (await api('GET', `/api/projects/${pid}/path`)).raw, // logged request must not leak either
    ];
    await new Promise((r) => setTimeout(r, 100));
    ws.close();

    const needles = [SECRET_FOLDER, SECRET_SUB, projectDir, projectDir.toLowerCase()];
    const ordinary = responses.slice(0, -1).join('\n');
    const eventsAndSessions = JSON.stringify(
      env.db.prepare('SELECT * FROM agent_events').all().concat(env.db.prepare('SELECT * FROM sessions').all(), env.db.prepare('SELECT * FROM notifications').all()),
    );
    const logs = fs.readFileSync(path.join(env.paths.logs, 'server.log'), 'utf8');
    expect(logs).toContain('/api/projects/:id/path'); // log is really written (route pattern only, no ids/paths)
    for (const n of needles) {
      expect(ordinary).not.toContain(n);
      expect(wsMessages.join('\n')).not.toContain(n);
      expect(eventsAndSessions.toLowerCase()).not.toContain(n.toLowerCase());
      expect(logs.toLowerCase()).not.toContain(n.toLowerCase());
    }
    expect(wsMessages.length).toBeGreaterThan(5);
    expect(responses.at(-1)).toContain(SECRET_FOLDER); // only via the dedicated endpoint
  });

  function keysFor(dir: string) {
    const secret = parseFolderKeySecret(fs.readFileSync(env.paths.folderKeySecret, 'utf8'))!;
    return folderKeysWithDepth(secret, pathForms(dir)).map((k) => k.key);
  }

  it('All sessions scope: registering a PARENT folder re-links sessions that ran in subfolders', async () => {
    await api('PUT', '/api/settings/scope', { scope: 'all', confirm: true });
    const sub = path.join(projectDir, 'src');
    await post(sanitized('s-unreg', 'SessionStart', { source: 'startup', folderKeys: keysFor(sub) }));
    let s = (await api('GET', '/api/sessions/s-unreg')).body;
    expect(s.projectId).toBeNull();
    expect(s.folderKeyShort).toMatch(/^[a-f0-9]{4}$/);
    const r = await api('POST', '/api/projects', { alias: 'Late', path: projectDir });
    expect(r.body.relinkedSessions).toBe(1);
    s = (await api('GET', '/api/sessions/s-unreg')).body;
    expect(s.projectAlias).toBe('Late');
  });

  it('PATCH path also re-links matching unassigned sessions', async () => {
    await api('PUT', '/api/settings/scope', { scope: 'all', confirm: true });
    const target = path.join(env.root, 'Elsewhere');
    fs.mkdirSync(target);
    await post(sanitized('s-unreg2', 'SessionStart', { source: 'startup', folderKeys: keysFor(target) }));
    const { body } = await api('POST', '/api/projects', { alias: 'P', path: projectDir });
    expect(body.relinkedSessions).toBe(0);
    const r = await api('PATCH', `/api/projects/${body.project.id}`, { path: target });
    expect(r.body.relinkedSessions).toBe(1);
  });

  it('rotation deletes the old key: old-kid sessions are never re-linked', async () => {
    await api('PUT', '/api/settings/scope', { scope: 'all', confirm: true });
    const oldKeys = keysFor(projectDir);
    await post(sanitized('s-old', 'SessionStart', { source: 'startup', folderKeys: oldKeys }));
    const before = fs.readFileSync(env.paths.folderKeySecret, 'utf8');
    const rot = await api('POST', '/api/integration/folder-key/rotate');
    expect(rot.status).toBe(200);
    const after = fs.readFileSync(env.paths.folderKeySecret, 'utf8');
    expect(after).not.toBe(before);
    expect(after).not.toContain(JSON.parse(before).key);
    const r = await api('POST', '/api/projects', { alias: 'P', path: projectDir });
    expect(r.body.relinkedSessions).toBe(0);
    expect((await api('GET', '/api/sessions/s-old')).body.projectId).toBeNull();
  });

  it('registered-only scope: no folder keys are stored and nothing is re-linked', async () => {
    await post(sanitized('s-r', 'SessionStart', { source: 'startup' }));
    expect(env.db.prepare('SELECT COUNT(*) AS c FROM session_folder_keys').get()).toEqual({ c: 0 });
    expect((await api('POST', '/api/projects', { alias: 'P', path: projectDir })).body.relinkedSessions).toBe(0);
  });
});
