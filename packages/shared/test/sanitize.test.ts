import { describe, it, expect } from 'vitest';
import { sanitizeHookPayload } from '../src/sanitize.ts';
import { SanitizedEventSchema } from '../src/events.ts';
import { FAIL_CLOSED_POLICY, parsePolicy, type CapturePolicy } from '../src/policy.ts';
import { resolveProject } from '../src/resolve.ts';
import { generateFolderKeySecret, folderKey, projectRootKeys } from '../src/folderKeys.ts';
import { classifyCommand, classifyFile } from '../src/classify.ts';

const SESSION = '0b0e7c1a-1111-4222-8333-444455556666';
const CANARY = {
  secret: 'sk-' + 'ant-api03-CANARYCANARYCANARY123456',
  email: 'canary.person@example.com',
  phone: '+63 917 555 0199',
  folder: 'C:\\Users\\SomeUser\\SecretClientFolder\\proj',
  fileBody: 'CANARY-FILE-CONTENTS-7f3a',
};

const policy = (over: Partial<CapturePolicy> = {}): CapturePolicy => ({
  ...FAIL_CLOSED_POLICY,
  version: 1,
  ...over,
});
const project = { kind: 'project' as const, projectId: 'proj_1' };
const fixed = { now: () => new Date('2026-11-22T00:00:00.000Z'), uuid: () => '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b' };

const base = (event: string, extra: Record<string, unknown> = {}) => ({
  session_id: SESSION,
  transcript_path: CANARY.folder + '\\t.jsonl',
  cwd: CANARY.folder,
  hook_event_name: event,
  permission_mode: 'default',
  ...extra,
});

function allStrings(v: unknown): string {
  return JSON.stringify(v);
}

describe('sanitizer: metadata-only allowlist', () => {
  it('drops prompt, cwd, transcript path and tool content by default', () => {
    const payloads = [
      base('UserPromptSubmit', { prompt: `use ${CANARY.secret} mail ${CANARY.email} call ${CANARY.phone}` }),
      base('PreToolUse', { tool_name: 'Read', tool_input: { file_path: CANARY.folder + '\\a.ts' }, tool_use_id: 'toolu_1' }),
      base('PostToolUse', {
        tool_name: 'Read',
        tool_input: { file_path: CANARY.folder + '\\a.ts' },
        tool_response: { content: CANARY.fileBody },
        tool_use_id: 'toolu_1',
      }),
      base('Notification', { message: `Claude needs permission ${CANARY.email}`, title: 'x', notification_type: 'permission_prompt' }),
      base('Stop', { last_assistant_message: CANARY.fileBody, stop_hook_active: false, background_tasks: [] }),
      base('StopFailure', { error: 'rate_limit', error_details: CANARY.secret, last_assistant_message: CANARY.email }),
      base('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: `echo ${CANARY.secret}` }, error: `Exit code 1\n${CANARY.fileBody}` }),
    ];
    for (const p of payloads) {
      const ev = sanitizeHookPayload(p, project, policy(), fixed);
      expect(ev).not.toBeNull();
      expect(SanitizedEventSchema.safeParse(ev).success).toBe(true);
      const s = allStrings(ev);
      for (const c of Object.values(CANARY)) expect(s).not.toContain(c);
      expect(s).not.toMatch(/SecretClientFolder|SomeUser|transcript|cwd/i);
      expect(ev!.content).toBeUndefined();
    }
  });

  it('keeps only allowlisted metadata fields', () => {
    const ev = sanitizeHookPayload(
      base('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'C:\\x\\tests\\login.spec.ts', old_string: 'a' }, tool_use_id: 'toolu_9', unknown_field: 'zzz' }),
      project,
      policy(),
      fixed,
    )!;
    expect(ev).toEqual({
      v: 1,
      eventId: fixed.uuid(),
      ts: '2026-11-22T00:00:00.000Z',
      sessionId: SESSION,
      event: 'PreToolUse',
      projectId: 'proj_1',
      folderKeys: [],
      permissionMode: 'default',
      toolName: 'Edit',
      toolUseId: 'toolu_9',
      fileCategory: 'test',
    });
  });

  it('reduces PostToolUseFailure errors to "Exit code N" or "tool_error"', () => {
    const a = sanitizeHookPayload(base('PostToolUseFailure', { tool_name: 'Bash', error: 'Exit code 2\nstack...' }), project, policy(), fixed)!;
    expect(a.error).toBe('Exit code 2');
    const b = sanitizeHookPayload(base('PostToolUseFailure', { tool_name: 'Bash', error: 'ENOENT C:\\secret' }), project, policy(), fixed)!;
    expect(b.error).toBe('tool_error');
    const c = sanitizeHookPayload(base('PostToolUseFailure', { tool_name: 'Bash', error: 'x', is_interrupt: true }), project, policy(), fixed)!;
    expect(c.isInterrupt).toBe(true);
  });

  it('accepts only enum StopFailure errors', () => {
    expect(sanitizeHookPayload(base('StopFailure', { error: 'rate_limit' }), project, policy(), fixed)!.error).toBe('rate_limit');
    expect(sanitizeHookPayload(base('StopFailure', { error: 'weird text here' }), project, policy(), fixed)!.error).toBe('unknown');
  });

  it('captures SessionStart source/model, SessionEnd reason, subagent identity, background task count', () => {
    const s = sanitizeHookPayload(base('SessionStart', { source: 'fork', model: 'claude-opus-5-5' }), project, policy(), fixed)!;
    expect(s.source).toBe('fork');
    expect(s.model).toBe('claude-opus-5-5');
    const e = sanitizeHookPayload(base('SessionEnd', { reason: 'prompt_input_exit' }), project, policy(), fixed)!;
    expect(e.reason).toBe('prompt_input_exit');
    const sa = sanitizeHookPayload(base('SubagentStart', { agent_id: 'agent-abc123', agent_type: 'Explore' }), project, policy(), fixed)!;
    expect([sa.agentId, sa.agentType]).toEqual(['agent-abc123', 'Explore']);
    const st = sanitizeHookPayload(
      base('Stop', { background_tasks: [{ status: 'running', command: CANARY.secret }, { status: 'done' }] }),
      project,
      policy(),
      fixed,
    )!;
    expect(st.backgroundTasksRunning).toBe(1);
    expect(allStrings(st)).not.toContain(CANARY.secret);
  });

  it('maps unknown events to "other" and keeps only a safe raw name', () => {
    const ev = sanitizeHookPayload(base('PreCompact'), project, policy(), fixed)!;
    expect(ev.event).toBe('other');
    expect(ev.rawEventName).toBe('PreCompact');
    const bad = sanitizeHookPayload(base('Weird Name; drop'), project, policy(), fixed)!;
    expect(bad.rawEventName).toBeUndefined();
  });

  it('rejects payloads without a valid session id', () => {
    expect(sanitizeHookPayload({ hook_event_name: 'Stop' }, project, policy(), fixed)).toBeNull();
    expect(sanitizeHookPayload({ session_id: '../../etc', hook_event_name: 'Stop' }, project, policy(), fixed)).toBeNull();
    expect(sanitizeHookPayload('nope', project, policy(), fixed)).toBeNull();
  });

  it('replaces unsafe tool names', () => {
    const ev = sanitizeHookPayload(base('PreToolUse', { tool_name: 'rm -rf C:\\' }), project, policy(), fixed)!;
    expect(ev.toolName).toBe('unknown');
  });
});

describe('sanitizer: explicit opt-in content', () => {
  it('includes redacted, truncated content only for enabled toggles', () => {
    const p = policy({ capture: { prompts: true, toolInputs: false, toolOutputs: true, notificationText: false } });
    const prompt = sanitizeHookPayload(base('UserPromptSubmit', { prompt: `key ${CANARY.secret} mail ${CANARY.email}` }), project, p, fixed)!;
    expect(prompt.content?.prompt).toContain('[REDACTED:anthropic_key]');
    expect(prompt.content?.prompt).toContain('[REDACTED:email]');
    expect(prompt.content?.prompt).not.toContain(CANARY.secret);
    const pre = sanitizeHookPayload(base('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'x' } }), project, p, fixed)!;
    expect(pre.content).toBeUndefined();
    const long = sanitizeHookPayload(base('PostToolUse', { tool_name: 'Read', tool_response: 'a'.repeat(9000) }), project, p, fixed)!;
    expect(long.content!.toolResponse!.length).toBeLessThan(2100);
    expect(SanitizedEventSchema.safeParse(long).success).toBe(true);
  });
});

describe('classification', () => {
  it.each([
    ['C:\\p\\tests\\login.spec.ts', 'test'],
    ['C:\\p\\src\\a.test.tsx', 'test'],
    ['C:\\p\\test_api.py', 'test'],
    ['C:\\p\\suites\\smoke.robot', 'test'],
    ['C:\\p\\src\\test\\java\\LoginTest.java', 'test'],
    ['C:\\p\\docs\\Test Cases - Login.md', 'test'],
    ['C:\\p\\README.md', 'doc'],
    ['C:\\p\\playwright.config.ts', 'config'],
    ['C:\\p\\src\\pages\\LoginPage.ts', 'source'],
    ['C:\\p\\image.png', 'other'],
  ])('classifyFile(%s) = %s', (p, cat) => expect(classifyFile(p)).toBe(cat));

  it.each([
    ['npx playwright test --project=chromium', 'test_run'],
    ['python -m pytest tests/', 'test_run'],
    ['pytest -k login', 'test_run'],
    ['robot --outputdir out suites/', 'test_run'],
    ['npm test', 'test_run'],
    ['npm run test:e2e', 'test_run'],
    ['mvn -q clean test', 'test_run'],
    ['dotnet test', 'test_run'],
    ['npm install', 'install'],
    ['pip install requests', 'install'],
    ['npm run build', 'build'],
    ['git status', 'git'],
    ['ls -la', 'other'],
  ])('classifyCommand(%s) = %s', (c, cat) => expect(classifyCommand(c)).toBe(cat));
});

describe('policy parsing (fail closed)', () => {
  it('returns the fail-closed policy for missing or corrupt files', () => {
    expect(parsePolicy(null)).toEqual({ policy: FAIL_CLOSED_POLICY, failClosed: true });
    expect(parsePolicy('{not json')).toEqual({ policy: FAIL_CLOSED_POLICY, failClosed: true });
    expect(parsePolicy('{"schema":1}')).toEqual({ policy: FAIL_CLOSED_POLICY, failClosed: true });
  });
  it('fail-closed policy drops every cwd', () => {
    expect(resolveProject('C:\\any\\where', FAIL_CLOSED_POLICY, () => null)).toEqual({ kind: 'drop', reason: 'unregistered' });
  });
});

describe('resolveProject', () => {
  const forms = (p: string) => ({ lexical: p.toLowerCase(), canonical: null });
  const pol = policy({
    projects: [{ id: 'p1', lexical: 'c:\\work\\proj', canonical: null }],
    excludes: [{ lexical: 'c:\\work\\proj\\private', canonical: null }],
  });

  it('resolves registered projects to an id only', () => {
    expect(resolveProject('C:\\Work\\Proj\\src', pol, () => null, forms)).toEqual({ kind: 'project', projectId: 'p1' });
  });
  it('drops excluded paths even inside a project', () => {
    expect(resolveProject('C:\\Work\\Proj\\private\\x', pol, () => null, forms)).toEqual({ kind: 'drop', reason: 'excluded' });
  });
  it('drops unregistered folders in registered-only scope without touching the secret', () => {
    let secretRead = false;
    const r = resolveProject('C:\\Elsewhere', pol, () => {
      secretRead = true;
      return generateFolderKeySecret();
    }, forms);
    expect(r).toEqual({ kind: 'drop', reason: 'unregistered' });
    expect(secretRead).toBe(false);
  });
  it('produces folder keys (self + ancestors) in All sessions scope', () => {
    const secret = generateFolderKeySecret();
    const r = resolveProject('C:\\Elsewhere\\Deep\\Dir', { ...pol, scope: 'all' }, () => secret, forms);
    expect(r.kind).toBe('unregistered');
    const keys = (r as { folderKeys: string[] }).folderKeys;
    expect(keys).toEqual([
      folderKey(secret, 'c:\\elsewhere\\deep\\dir'),
      folderKey(secret, 'c:\\elsewhere\\deep'),
      folderKey(secret, 'c:\\elsewhere'),
    ]);
    // a later registration of the parent folder can be re-linked via its root key
    expect(keys).toContain(projectRootKeys(secret, { lexical: 'c:\\elsewhere', canonical: null })[0]);
    expect(JSON.stringify(keys)).not.toMatch(/elsewhere|deep/i);
  });
  it('sends an empty key list when the secret is missing', () => {
    expect(resolveProject('C:\\Elsewhere', { ...pol, scope: 'all' }, () => null, forms)).toEqual({
      kind: 'unregistered',
      folderKeys: [],
    });
  });
  it('drops events without a usable cwd', () => {
    expect(resolveProject(undefined, pol, () => null)).toEqual({ kind: 'drop', reason: 'no_cwd' });
  });
});

describe('opt-in content: registered project paths are masked', () => {
  const root = 'C:\\Work\\ClientAlphaSecret\\repo';
  const pol = policy({
    capture: { prompts: true, toolInputs: true, toolOutputs: true, notificationText: true },
    projects: [{ id: 'proj_1', lexical: 'c:\\work\\clientalphasecret\\repo', canonical: 'd:\\real\\clientalpha-canonical\\repo' }],
    excludes: [{ lexical: 'c:\\work\\private-zone', canonical: null }],
  });

  it.each([
    [`edit ${root}\\src\\a.ts please`, 'edit <project>\\src\\a.ts please'],
    ['edit c:/work/clientalphasecret/repo/src/a.ts', 'edit <project>/src/a.ts'],
    ['EDIT C:\\WORK\\CLIENTALPHASECRET\\REPO', 'EDIT <project>'],
    ['canon D:\\Real\\ClientAlpha-Canonical\\repo\\x', 'canon <project>\\x'],
    ['see C:\\Work\\Private-Zone\\notes.txt', 'see <project>\\notes.txt'],
    ['double slashes C:\\\\Work\\\\ClientAlphaSecret\\\\repo', 'double slashes <project>'],
  ])('masks %s', (input, expected) => {
    const ev = sanitizeHookPayload(base('UserPromptSubmit', { prompt: input }), project, pol, fixed)!;
    expect(ev.content?.prompt).toBe(expected);
  });

  it('masks inside tool input/output, and does not touch similarly named siblings', () => {
    const ev = sanitizeHookPayload(
      base('PostToolUse', { tool_name: 'Read', tool_input: { file_path: root + '\\a.ts' }, tool_response: { out: `${root}\\b.ts` } }),
      project,
      pol,
      fixed,
    )!;
    expect(ev.content?.toolInput).not.toContain('ClientAlphaSecret');
    expect(ev.content?.toolResponse).not.toContain('ClientAlphaSecret');
    const sibling = sanitizeHookPayload(base('UserPromptSubmit', { prompt: 'C:\\Work\\ClientAlphaSecret\\repo-old\\x' }), project, pol, fixed)!;
    expect(sibling.content?.prompt).toContain('repo-old'); // not a boundary match for the project root
  });
});
