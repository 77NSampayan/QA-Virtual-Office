import { describe, expect, it } from 'vitest';
import { checkDefectTransition, checkTaskMove, DEFECT_STATUSES, isOpenDefect, nextDefectStatuses } from '../src/defects.ts';

describe('defect transitions', () => {
  it('follows the workflow: new → open → in progress → fixed → ready to retest → closed', () => {
    const path = ['new', 'open', 'in_progress', 'fixed', 'retest', 'closed'] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(checkDefectTransition(path[i]!, path[i + 1]!, 'human', 'note')).toEqual({ ok: true });
    }
  });
  it('cannot skip steps (new straight to closed, open to fixed)', () => {
    expect(checkDefectTransition('new', 'closed', 'human', 'x')).toMatchObject({ ok: false, code: 'invalid_transition' });
    expect(checkDefectTransition('open', 'fixed', 'human', 'x')).toMatchObject({ ok: false, code: 'invalid_transition' });
    expect(checkDefectTransition('fixed', 'closed', 'human', 'x')).toMatchObject({ ok: false, code: 'invalid_transition' });
  });
  it('NO non-human can make ANY status change, including closing', () => {
    for (const from of DEFECT_STATUSES) {
      for (const to of nextDefectStatuses(from)) {
        for (const actor of ['agent', 'system'] as const) {
          expect(checkDefectTransition(from, to, actor, 'note'), `${actor} ${from}->${to}`).toMatchObject({ ok: false, code: 'human_required' });
        }
      }
    }
  });
  it('closing, rejecting, duplicate and reopening need a note', () => {
    expect(checkDefectTransition('retest', 'closed', 'human', ' ')).toMatchObject({ code: 'note_required' });
    expect(checkDefectTransition('new', 'rejected', 'human', '')).toMatchObject({ code: 'note_required' });
    expect(checkDefectTransition('new', 'duplicate', 'human', '')).toMatchObject({ code: 'note_required' });
    expect(checkDefectTransition('closed', 'reopened', 'human', '')).toMatchObject({ code: 'note_required' });
    expect(checkDefectTransition('new', 'open', 'human', '')).toEqual({ ok: true });
  });
  it('finished defects are not "open"; a closed defect can only be reopened', () => {
    expect(['closed', 'rejected', 'duplicate'].map((s) => isOpenDefect(s as 'closed'))).toEqual([false, false, false]);
    expect(isOpenDefect('retest')).toBe(true);
    expect(nextDefectStatuses('closed')).toEqual(['reopened']);
  });
});

describe('task board moves', () => {
  it('only a person completes a task; agents can move it elsewhere', () => {
    expect(checkTaskMove('waiting_review', 'completed', 'agent', 'x')).toMatchObject({ ok: false, code: 'human_required' });
    expect(checkTaskMove('waiting_review', 'completed', 'human', '')).toEqual({ ok: true });
    expect(checkTaskMove('backlog', 'ready', 'agent', '')).toEqual({ ok: true });
  });
  it('blocking and reopening a completed task need a reason; a no-op move is refused', () => {
    expect(checkTaskMove('in_progress', 'blocked', 'human', '')).toMatchObject({ code: 'note_required' });
    expect(checkTaskMove('in_progress', 'blocked', 'human', 'Environment down')).toEqual({ ok: true });
    expect(checkTaskMove('completed', 'in_progress', 'human', '')).toMatchObject({ code: 'note_required' });
    expect(checkTaskMove('ready', 'ready', 'human', 'x')).toMatchObject({ code: 'unchanged' });
  });
});
