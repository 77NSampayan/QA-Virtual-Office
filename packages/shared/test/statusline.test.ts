import { describe, it, expect } from 'vitest';
import { formatStatusLine, sanitizeStatusLine, StatusLineSnapshotSchema } from '../src/statusline.ts';

const project = { kind: 'project' as const, projectId: 'proj_1' };
const now = () => new Date('2026-11-22T00:00:00.000Z');
const CANARY = 'C:\\Users\\SomeUser\\SecretClientFolder';

const payload = {
  session_id: 'sl-session-1',
  session_name: 'Customer Payroll Fix',
  transcript_path: CANARY + '\\t.jsonl',
  cwd: CANARY,
  version: '2.1.260',
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  workspace: { current_dir: CANARY, project_dir: CANARY, repo: { owner: 'acme', name: 'payroll' } },
  cost: { total_cost_usd: 1.2345, total_duration_ms: 90_000.4, total_api_duration_ms: 40_000, total_lines_added: 10 },
  context_window: { used_percentage: 42.5, context_window_size: 200000, current_usage: { input_tokens: 1 } },
  rate_limits: {
    five_hour: { used_percentage: 12, resets_at: 1795400000 },
    seven_day: { used_percentage: 3.5, resets_at: '2026-11-29T00:00:00Z' },
  },
  pr: { url: 'https://github.com/acme/payroll/pull/9' },
  worktree: { path: CANARY },
};

describe('sanitizeStatusLine', () => {
  it('keeps numbers and model only; drops cwd, transcript, session name, repo, PR, worktree', () => {
    const snap = sanitizeStatusLine(payload, project, now)!;
    expect(StatusLineSnapshotSchema.safeParse(snap).success).toBe(true);
    expect(snap).toMatchObject({
      sessionId: 'sl-session-1',
      projectId: 'proj_1',
      modelId: 'claude-opus-5-5',
      modelName: 'Opus 5.5',
      costUsd: 1.2345,
      durationMs: 90000,
      apiDurationMs: 40000,
      contextUsedPct: 42.5,
      contextWindowSize: 200000,
      fiveHourPct: 12,
      sevenDayPct: 3.5,
    });
    expect(snap.fiveHourResetsAt).toBe(new Date(1795400000 * 1000).toISOString());
    expect(snap.sevenDayResetsAt).toBe('2026-11-29T00:00:00.000Z');
    const s = JSON.stringify(snap);
    for (const bad of ['SecretClientFolder', 'SomeUser', 'Payroll', 'acme', 'pull/9', 'transcript', 'cwd']) {
      expect(s).not.toContain(bad);
    }
  });

  it('tolerates missing optional parts (early session: nulls)', () => {
    const snap = sanitizeStatusLine({ session_id: 's1', context_window: { used_percentage: null, current_usage: null } }, project, now)!;
    expect(snap.contextUsedPct).toBeUndefined();
    expect(Object.keys(snap).sort()).toEqual(['folderKeys', 'projectId', 'sessionId', 'ts', 'v']);
  });

  it('clamps out-of-range values and rejects unsafe model strings', () => {
    const snap = sanitizeStatusLine(
      { session_id: 's1', model: { id: 'a;rm -rf', display_name: 'x\ny' }, context_window: { used_percentage: 400 }, cost: { total_cost_usd: -5 } },
      project,
      now,
    )!;
    expect(snap.modelId).toBeUndefined();
    expect(snap.modelName).toBeUndefined();
    expect(snap.contextUsedPct).toBe(100);
    expect(snap.costUsd).toBe(0);
  });

  it('rejects payloads without a valid session id', () => {
    expect(sanitizeStatusLine({}, project, now)).toBeNull();
    expect(sanitizeStatusLine({ session_id: '../x' }, project, now)).toBeNull();
    expect(sanitizeStatusLine(null, project, now)).toBeNull();
  });

  it('carries folder keys for unregistered folders and never a project id', () => {
    const snap = sanitizeStatusLine({ session_id: 's1' }, { kind: 'unregistered', folderKeys: ['a1b2c3d4:' + 'a'.repeat(32)] }, now)!;
    expect(snap.projectId).toBeNull();
    expect(snap.folderKeys).toHaveLength(1);
  });

  it('formats a compact line', () => {
    expect(formatStatusLine(sanitizeStatusLine(payload, project, now)!)).toBe('QA Office · Opus 5.5 · ctx 43%');
  });
});
