import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ingest } from '../src/collector.ts';
import { openDb, type DB } from '../src/db/index.ts';
import { sessionDto } from '../src/store.ts';

let db: DB;
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qavo-act-'));
  db = openDb(path.join(root, 'test.db'));
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const send = (sessionId: string, event: string, extra: Record<string, unknown> = {}) =>
  ingest(db, { v: 1, eventId: crypto.randomUUID(), ts: new Date().toISOString(), sessionId, event, projectId: null, folderKeys: [], ...extra }, () => undefined);

describe('session activity (the current tool, metadata only)', () => {
  it('is null until a tool has been used', () => {
    send('s1', 'SessionStart', { source: 'startup' });
    send('s1', 'UserPromptSubmit');
    expect(sessionDto(db, 's1')!.activity).toBeNull();
  });

  it('follows the latest tool event of the main agent, with the categories the forwarder derived', () => {
    send('s1', 'SessionStart', { source: 'startup' });
    send('s1', 'PreToolUse', { toolName: 'Read' });
    expect(sessionDto(db, 's1')!.activity).toMatchObject({ tool: 'Read', fileCategory: null, commandCategory: null });
    send('s1', 'PreToolUse', { toolName: 'Write', fileCategory: 'test' });
    expect(sessionDto(db, 's1')!.activity).toMatchObject({ tool: 'Write', fileCategory: 'test' });
    send('s1', 'PreToolUse', { toolName: 'Bash', commandCategory: 'test_run' });
    const a = sessionDto(db, 's1')!.activity!;
    expect(a).toMatchObject({ tool: 'Bash', commandCategory: 'test_run' });
    expect(a.at).toBeGreaterThan(Date.now() - 10_000);
  });

  it('ignores subagent tool events (a drone is not the robot) and other sessions', () => {
    send('s1', 'SessionStart', { source: 'startup' });
    send('s1', 'PreToolUse', { toolName: 'Read' });
    send('s1', 'SubagentStart', { agentId: 'a1', agentType: 'Explore' });
    send('s1', 'PreToolUse', { toolName: 'Bash', commandCategory: 'build', agentId: 'a1', agentType: 'Explore' });
    send('s2', 'SessionStart', { source: 'startup' });
    send('s2', 'PreToolUse', { toolName: 'Grep' });
    expect(sessionDto(db, 's1')!.activity).toMatchObject({ tool: 'Read' });
    expect(sessionDto(db, 's2')!.activity).toMatchObject({ tool: 'Grep' });
  });

  it('carries nothing but the tool name and two categories: events with paths or commands are not even accepted', () => {
    send('s1', 'SessionStart', { source: 'startup' });
    expect(() => send('s1', 'PreToolUse', { toolName: 'Bash', commandCategory: 'git', toolInput: { command: 'git push origin secret-branch' } })).toThrow(/invalid_event/);
    expect(() => send('s1', 'PreToolUse', { toolName: 'Bash', cwd: 'C:/Users/jane/project' })).toThrow(/invalid_event/);
    send('s1', 'PreToolUse', { toolName: 'Bash', commandCategory: 'git' });
    const json = JSON.stringify(sessionDto(db, 's1')!.activity);
    expect(Object.keys(JSON.parse(json)).sort()).toEqual(['at', 'commandCategory', 'fileCategory', 'tool']);
    expect(json).not.toContain('secret-branch');
    expect(json).not.toContain('jane');
  });
});
