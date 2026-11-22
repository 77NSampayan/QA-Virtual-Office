import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnv, uiHeaders, type TestEnv } from './helpers.ts';

const ROOT = path.resolve(__dirname, '../../..');
const BUNDLE = path.join(ROOT, 'apps/forwarder/dist/forward.mjs');
let env: TestEnv;
let dirs: { alpha: string; beta: string };

beforeAll(async () => {
  execFileSync(process.execPath, [path.join(ROOT, 'apps/forwarder/build.mjs')]);
  env = await makeEnv({ listen: true });
  dirs = { alpha: path.join(env.root, 'AlphaProj'), beta: path.join(env.root, 'BetaProj') };
  fs.mkdirSync(path.join(dirs.alpha, 'src'), { recursive: true });
  fs.mkdirSync(dirs.beta, { recursive: true });
  const mk = async (alias: string, p: string) =>
    (await env.app.inject({ method: 'POST', url: '/api/projects', headers: uiHeaders(env), payload: { alias, path: p } })).json().project.id as string;
  await mk('Alpha', dirs.alpha);
  await mk('Beta', dirs.beta);
});
afterAll(async () => env.cleanup());

const hook = (payload: object) =>
  new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, [BUNDLE], { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, QAVO_DATA_DIR: env.dataDir } });
    child.on('close', resolve);
    child.stdin.end(JSON.stringify(payload));
  });

const get = async (url: string) => (await env.app.inject({ method: 'GET', url, headers: { host: env.host } })).json();

async function runSession(sid: string, cwd: string, steps: Array<Record<string, unknown>>) {
  for (const step of steps) {
    expect(await hook({ session_id: sid, cwd, transcript_path: cwd + '\\t.jsonl', permission_mode: 'default', ...step })).toBe(0);
  }
}

describe('B2 (synthetic): concurrent sessions, projects and a subagent', () => {
  it('tracks 3 concurrent sessions in 2 projects plus a subagent independently', async () => {
    const A1 = 'conc-alpha-1';
    const A2 = 'conc-alpha-2';
    const B1 = 'conc-beta-1';
    await Promise.all([
      // Alpha #1: writes tests, spawns an Explore subagent that asks for permission, then finishes
      runSession(A1, path.join(dirs.alpha, 'src'), [
        { hook_event_name: 'SessionStart', source: 'startup' },
        { hook_event_name: 'UserPromptSubmit' },
        { hook_event_name: 'SubagentStart', agent_id: 'agent-x1', agent_type: 'Explore' },
        { hook_event_name: 'PreToolUse', agent_id: 'agent-x1', tool_name: 'Grep', tool_use_id: 't1' },
        { hook_event_name: 'PermissionRequest', agent_id: 'agent-x1', tool_name: 'Bash' },
        { hook_event_name: 'PostToolUse', agent_id: 'agent-x1', tool_name: 'Bash', tool_use_id: 't1' },
        { hook_event_name: 'SubagentStop', agent_id: 'agent-x1', agent_type: 'Explore' },
        { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(dirs.alpha, 'tests', 'a.spec.ts') }, tool_use_id: 't2' },
        { hook_event_name: 'Stop' },
      ]),
      // Alpha #2 (same project): runs tests that fail, ends up debugging
      runSession(A2, dirs.alpha, [
        { hook_event_name: 'SessionStart', source: 'startup' },
        { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npx playwright test' }, tool_use_id: 't3' },
        { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', error: 'Exit code 1', tool_use_id: 't3' },
        { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't4' },
      ]),
      // Beta #1 (other project): hits a permission prompt and stays there
      runSession(B1, dirs.beta, [
        { hook_event_name: 'SessionStart', source: 'startup' },
        { hook_event_name: 'UserPromptSubmit' },
        { hook_event_name: 'PermissionRequest', tool_name: 'Edit' },
        { hook_event_name: 'Notification', notification_type: 'permission_prompt' },
      ]),
    ]);

    const sessions = (await get('/api/sessions')) as Array<{ sessionId: string; robot: { id: string }; drones: Array<Record<string, unknown>> } & Record<string, unknown>>;
    const by = Object.fromEntries(sessions.map((s) => [s.sessionId, s]));
    expect(by[A1]!).toMatchObject({ projectAlias: 'Alpha', status: 'completed', statusSource: 'event' });
    expect(by[A2]!).toMatchObject({ projectAlias: 'Alpha', status: 'debugging', statusSource: 'inferred' });
    expect(by[B1]!).toMatchObject({ projectAlias: 'Beta', status: 'awaiting_permission', pendingPermissionTool: 'Edit' });

    // distinct robots (concurrent sessions never share one)
    const robotIds = new Set([A1, A2, B1].map((s) => by[s]!.robot.id));
    expect(robotIds.size).toBe(3);

    // the subagent drone: created, asked permission (parent too), was approved, stopped -> completed
    expect(by[A1]!.drones).toHaveLength(1);
    expect(by[A1]!.drones[0]).toMatchObject({ agentId: 'agent-x1', agentType: 'Explore', status: 'completed' });
    expect(by[A2]!.drones).toEqual([]);
    expect(by[B1]!.drones).toEqual([]);

    // events never cross sessions or projects
    for (const [sid, alias] of [[A1, 'Alpha'], [A2, 'Alpha'], [B1, 'Beta']] as const) {
      const rows = env.db
        .prepare('SELECT DISTINCT p.alias AS alias FROM agent_events e LEFT JOIN projects p ON p.id = e.project_id WHERE e.session_id = ?')
        .all(sid) as Array<{ alias: string }>;
      expect(rows).toEqual([{ alias }]);
    }
    expect((env.db.prepare('SELECT COUNT(*) AS c FROM agent_events WHERE session_id = ?').get(A1) as { c: number }).c).toBe(9);

    // notifications: one permission per prompt episode (A1's subagent prompt, B1's), one completion (A1)
    const notes = (await get('/api/notifications')) as Array<{ kind: string; sessionId: string }>;
    const count = (sid: string, kind: string) => notes.filter((n) => n.sessionId === sid && n.kind === kind).length;
    expect(count(A1, 'permission_required')).toBe(1);
    expect(count(A1, 'session_completed')).toBe(1);
    expect(count(B1, 'permission_required')).toBe(1);
    expect(count(A2, 'permission_required')).toBe(0);

    // every row used a documented matrix rule
    const rules = (env.db.prepare('SELECT DISTINCT rule FROM agent_events').all() as Array<{ rule: string }>).map((r) => r.rule);
    expect(rules.every((r) => /^(\d+[a-c]?)(\+\d+[a-c]?)*$/.test(r))).toBe(true);
  }, 60000);

  it('stays consistent under a burst of interleaved events from many sessions', async () => {
    const sids = Array.from({ length: 8 }, (_, i) => `burst-${i}`);
    await Promise.all(
      sids.map((sid, i) =>
        runSession(sid, i % 2 ? dirs.alpha : dirs.beta, [
          { hook_event_name: 'SessionStart', source: 'startup' },
          ...Array.from({ length: 4 }, (_, k) => ({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: `b${i}-${k}` })),
          { hook_event_name: 'Stop' },
        ]),
      ),
    );
    for (const sid of sids) {
      const s = await get(`/api/sessions/${sid}`);
      expect(s.status).toBe('completed');
      expect((env.db.prepare('SELECT COUNT(*) AS c FROM agent_events WHERE session_id = ?').get(sid) as { c: number }).c).toBe(6);
    }
    expect(env.db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  }, 90000);
});
