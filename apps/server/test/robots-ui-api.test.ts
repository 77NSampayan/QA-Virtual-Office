import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { openDb } from '../src/db/index.ts';
import { ingest } from '../src/collector.ts';
import { makeEnv, uiHeaders, type TestEnv } from './helpers.ts';

let env: TestEnv;
beforeEach(async () => {
  env = await makeEnv({ listen: true });
});
afterEach(async () => env.cleanup());

const api = async (method: string, url: string, payload?: unknown) => {
  const r = await env.app.inject({ method: method as 'GET', url, headers: uiHeaders(env), payload: payload as object });
  return { status: r.statusCode, body: r.body ? r.json() : null, raw: r.body };
};

let seq = 0;
function ev(sessionId: string, event: string, extra: Record<string, unknown> = {}) {
  seq++;
  return ingest(env.db, { v: 1, eventId: crypto.randomUUID(), ts: new Date(Date.UTC(2026, 10, 22, 1, 0, seq)).toISOString(), sessionId, event, projectId: null, folderKeys: [], ...extra }, env.broadcast);
}

describe('robots API', () => {
  it('lists robots with identity, palette and their latest session state', async () => {
    ev('s1', 'SessionStart', { source: 'startup' });
    ev('s1', 'PermissionRequest', { toolName: 'Write' });
    const list = (await api('GET', '/api/robots')).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      name: expect.stringMatching(/^Unit-/),
      robotType: 'qa_analyst',
      role: 'qa_analyst',
      palette: { primary: '#6f7fe8', accent: '#ffd54a' }, // type default
      session: { sessionId: 's1', status: 'awaiting_permission', statusSource: 'event' },
    });
  });

  it('PATCH validates and persists name, appearance, role and colours', async () => {
    ev('s1', 'SessionStart', { source: 'startup' });
    const id = (await api('GET', '/api/robots')).body[0].id;
    const ok = await api('PATCH', `/api/robots/${id}`, { name: 'Tess', robotType: 'bug_investigator', role: 'api_tester', palette: { primary: '#112233', accent: '#ABCDEF' } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ name: 'Tess', robotType: 'bug_investigator', role: 'api_tester', palette: { primary: '#112233', accent: '#ABCDEF' } });
    for (const bad of [
      { name: '' },
      { name: 'x'.repeat(31) },
      { name: 'bad\nname' },
      { name: 'a/b' },
      { robotType: 'wizard' },
      { role: 'ceo' },
      { palette: { primary: 'red', accent: '#ffffff' } },
      { palette: { primary: '#ffffff' } },
    ]) {
      expect((await api('PATCH', `/api/robots/${id}`, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await api('PATCH', '/api/robots/bot_missing', { name: 'x' })).status).toBe(404);
    expect((await api('GET', '/api/robots')).body[0].name).toBe('Tess'); // rejected edits changed nothing
  });

  it('C3: customizations survive a restart (database reopened)', async () => {
    ev('s1', 'SessionStart', { source: 'startup' });
    const id = (await api('GET', '/api/robots')).body[0].id;
    ev('s1', 'SessionEnd'); // the robot is free again, as after closing the terminal
    await api('PATCH', `/api/robots/${id}`, { name: 'Persisto', robotType: 'qa_lead', role: 'qa_lead', palette: { primary: '#010203', accent: '#fefdfc' } });
    const dbFile = env.paths.db;
    env.db.close();
    const reopened = openDb(dbFile);
    const row = reopened.prepare('SELECT name, robot_type, role, palette_json FROM robots WHERE id = ?').get(id) as Record<string, string>;
    expect(row).toMatchObject({ name: 'Persisto', robot_type: 'qa_lead', role: 'qa_lead' });
    expect(JSON.parse(row.palette_json!)).toEqual({ primary: '#010203', accent: '#fefdfc' });
    reopened.close();
    // identity also survives a new session in the same project: the same robot is reused
    const db2 = openDb(dbFile);
    const { ingest: ingest2 } = await import('../src/collector.ts');
    ingest2(db2, { v: 1, eventId: crypto.randomUUID(), ts: new Date(Date.UTC(2026, 10, 22, 2, 0, 0)).toISOString(), sessionId: 's2', event: 'SessionStart', source: 'startup', projectId: null, folderKeys: [] }, () => undefined);
    const s2 = db2.prepare('SELECT r.name FROM sessions s JOIN robots r ON r.id = s.robot_id WHERE s.session_id = ?').get('s2') as { name: string };
    expect(s2.name).toBe('Persisto');
    db2.close();
    env.db = openDb(dbFile); // for cleanup symmetry
    env.db.close();
  });

  it('robot edits are broadcast to connected clients', async () => {
    ev('s1', 'SessionStart', { source: 'startup' });
    const id = (await api('GET', '/api/robots')).body[0].id;
    const seen: Array<{ type: string }> = [];
    const WebSocket = (await import('ws')).default;
    const ws = new WebSocket(`ws://127.0.0.1:${env.port}/ws`, { origin: env.origin });
    await new Promise((r) => ws.once('message', r));
    ws.on('message', (d) => seen.push(JSON.parse(String(d))));
    await api('PATCH', `/api/robots/${id}`, { name: 'Pinged' });
    await new Promise((r) => setTimeout(r, 100));
    ws.close();
    expect(seen.some((m) => m.type === 'robot.updated')).toBe(true);
  });
});

describe('notifications read state', () => {
  it('mark read / unread / all, with unread count', async () => {
    ev('s1', 'SessionStart', { source: 'startup' });
    ev('s1', 'PermissionRequest', { toolName: 'Bash' });
    ev('s1', 'Stop');
    const list = (await api('GET', '/api/notifications')).body as Array<{ id: string; readAt: string | null }>;
    expect(list).toHaveLength(2);
    expect(list.every((n) => n.readAt === null)).toBe(true);
    const first = list[0]!.id;
    expect((await api('POST', '/api/notifications/read', { ids: [first] })).body).toMatchObject({ changed: 1, unread: 1 });
    expect(((await api('GET', '/api/notifications')).body as Array<{ id: string; readAt: string | null }>).find((n) => n.id === first)!.readAt).toMatch(/^\d{4}-/);
    expect((await api('POST', '/api/notifications/read', { ids: [first], read: false })).body).toMatchObject({ changed: 1, unread: 2 });
    expect((await api('POST', '/api/notifications/read', { all: true })).body).toMatchObject({ unread: 0 });
    expect((await api('POST', '/api/notifications/read', {})).status).toBe(400);
    expect((await api('POST', '/api/notifications/read', { ids: ['x'.repeat(100)] })).status).toBe(400);
  });
});

describe('activity feed', () => {
  it('returns recent real events with robot and project alias, newest first, never paths', async () => {
    const dir = path.join(env.root, 'ActivityProject');
    fs.mkdirSync(dir);
    const pid = (await api('POST', '/api/projects', { alias: 'Act', path: dir })).body.project.id;
    ev('s1', 'SessionStart', { source: 'startup', projectId: pid });
    ev('s1', 'PreToolUse', { toolName: 'Write', fileCategory: 'test', projectId: pid });
    ev('s2', 'SessionStart', { source: 'startup' });
    const all = (await api('GET', '/api/activity?limit=10')).body;
    expect(all).toHaveLength(3);
    expect(all[0]).toMatchObject({ sessionId: 's2', event: 'SessionStart', projectAlias: null });
    expect(all[1]).toMatchObject({ event: 'PreToolUse', toolName: 'Write', projectAlias: 'Act', statusAfter: 'writing_tests', robotName: expect.stringMatching(/^Unit-/) });
    const mine = (await api('GET', `/api/activity?projectId=${pid}`)).body;
    expect(mine.map((e: { sessionId: string }) => e.sessionId)).toEqual(['s1', 's1']);
    expect((await api('GET', '/api/activity?limit=99999')).status).toBe(400);
    expect(JSON.stringify(all)).not.toContain('ActivityProject');
  });
});

describe('project room summary', () => {
  it('counts robots, sessions and states for a project from real data only', async () => {
    const dir = path.join(env.root, 'RoomProject');
    fs.mkdirSync(dir);
    const pid = (await api('POST', '/api/projects', { alias: 'Room', path: dir })).body.project.id;
    ev('r1', 'SessionStart', { source: 'startup', projectId: pid });
    ev('r1', 'PreToolUse', { toolName: 'Bash', commandCategory: 'test_run', projectId: pid });
    ev('r2', 'SessionStart', { source: 'startup', projectId: pid });
    ev('r2', 'SessionEnd', { projectId: pid });
    const room = (await api('GET', `/api/projects/${pid}/room`)).body;
    expect(room).toMatchObject({ project: { alias: 'Room' }, sessionCount: 2, activeSessions: 1, robotCount: 2 });
    expect(room.byStatus).toMatchObject({ executing_tests: 1, disconnected: 1 });
    expect(room.lastActivityAt).toMatch(/^\d{4}-/);
    expect((await api('GET', '/api/projects/proj_nope/room')).status).toBe(404);
    expect(JSON.stringify(room)).not.toContain('RoomProject');
  });
});
