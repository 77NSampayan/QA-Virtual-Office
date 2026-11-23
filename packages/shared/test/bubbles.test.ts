import { describe, expect, it } from 'vitest';
import { BUBBLE_FRESH_MS, currentBubble, toolBubble, WORKING_STATUSES } from '../src/bubbles.ts';

describe('toolBubble: wording comes from tool name and categories only', () => {
  it.each([
    ['Read', null, null, 'reading'],
    ['Grep', null, null, 'reading'],
    ['WebSearch', null, null, 'searching the web'],
    ['Write', 'test', null, 'writing tests'],
    ['Edit', 'source', null, 'editing code'],
    ['MultiEdit', 'doc', null, 'writing docs'],
    ['Edit', 'config', null, 'editing config'],
    ['Edit', 'other', null, 'editing'],
    ['Edit', null, null, 'editing'],
    ['Bash', null, 'test_run', 'running tests'],
    ['Bash', null, 'build', 'building'],
    ['Bash', null, 'git', 'using git'],
    ['Bash', null, 'install', 'installing'],
    ['Bash', null, 'other', 'in the terminal'],
    ['Task', null, null, 'delegating'],
    ['TodoWrite', null, null, 'planning'],
    ['mcp__qa-office__qa_list_projects', null, null, 'using a tool'],
    ['SomethingNew', null, null, 'working'],
  ] as const)('%s / %s / %s -> %s', (tool, file, cmd, text) => expect(toolBubble(tool, file, cmd)).toBe(text));

  it('returns null without a tool and is case-insensitive', () => {
    expect(toolBubble(null)).toBeNull();
    expect(toolBubble('')).toBeNull();
    expect(toolBubble('BASH', null, 'test_run')).toBe('running tests');
  });

  it('never echoes anything it was given beyond the fixed phrases', () => {
    const secretish = toolBubble('Bash', 'C:\\Users\\jane\\secret.txt', 'rm -rf /home/jane');
    expect(secretish).toBe('in the terminal');
    expect(toolBubble('Edit', 'passwords.env', null)).toBe('editing');
  });
});

describe('currentBubble', () => {
  const act = (at: number) => ({ tool: 'Bash', fileCategory: null, commandCategory: 'test_run', at });
  it('shows only while working and only for a recent tool', () => {
    const now = 1_000_000;
    for (const s of WORKING_STATUSES) expect(currentBubble(s, act(now - 5000), now)).toBe('running tests');
    for (const s of ['idle', 'completed', 'awaiting_permission', 'awaiting_input', 'failed', 'disconnected']) expect(currentBubble(s, act(now - 5000), now)).toBeNull();
    expect(currentBubble('analyzing', act(now - BUBBLE_FRESH_MS - 1), now)).toBeNull();
    expect(currentBubble('analyzing', null, now)).toBeNull();
    expect(currentBubble('analyzing', undefined, now)).toBeNull();
  });
});
