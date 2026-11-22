import { describe, expect, it } from 'vitest';
import { checkExecutionChange, evidenceTypeFor, matchesMagic, safeFileName } from '../src/execution.ts';

describe('execution rules', () => {
  it('an agent can never mark a test PASSED or SKIPPED; a person can', () => {
    for (const to of ['passed', 'skipped'] as const) {
      expect(checkExecutionChange('not_run', to, 'agent', 'because')).toMatchObject({ ok: false, code: 'human_required' });
      expect(checkExecutionChange('not_run', to, 'system', 'because')).toMatchObject({ ok: false, code: 'human_required' });
    }
    expect(checkExecutionChange('in_progress', 'passed', 'human', '')).toEqual({ ok: true });
  });
  it('FAILED, BLOCKED and SKIPPED need a note', () => {
    for (const to of ['failed', 'blocked', 'skipped'] as const) {
      expect(checkExecutionChange('in_progress', to, 'human', '  ')).toMatchObject({ ok: false, code: 'note_required' });
      expect(checkExecutionChange('in_progress', to, 'human', 'why')).toEqual({ ok: true });
    }
  });
  it('changing a finished result needs a note; an unchanged result is refused', () => {
    expect(checkExecutionChange('failed', 'passed', 'human', '')).toMatchObject({ code: 'note_required' });
    expect(checkExecutionChange('failed', 'passed', 'human', 'fixed in build 2')).toEqual({ ok: true });
    expect(checkExecutionChange('passed', 'passed', 'human', 'x')).toMatchObject({ code: 'unchanged' });
  });
  it('agents may start a test or report it failed/blocked with a note', () => {
    expect(checkExecutionChange('not_run', 'in_progress', 'agent', '')).toEqual({ ok: true });
    expect(checkExecutionChange('in_progress', 'failed', 'agent', 'Error shown')).toEqual({ ok: true });
  });
});

describe('evidence files', () => {
  it('allows only known types, by extension, and checks magic bytes', () => {
    expect(evidenceTypeFor('shot.PNG')?.mime).toBe('image/png');
    expect(evidenceTypeFor('run.log')?.text).toBe(true);
    expect(evidenceTypeFor('virus.exe')).toBeNull();
    expect(evidenceTypeFor('noext')).toBeNull();
    expect(evidenceTypeFor('page.html')).toBeNull();
    const png = evidenceTypeFor('a.png')!;
    expect(matchesMagic(png, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0]))).toBe(true);
    expect(matchesMagic(png, Uint8Array.from([0x4d, 0x5a]))).toBe(false);
  });
  it('file names lose directories and control characters', () => {
    expect(safeFileName('C:\\Users\\x\\secret\\shot.png')).toBe('shot.png');
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('a<b>.png')).toBe('a_b_.png');
    expect(safeFileName('')).toBe('file');
  });
});
