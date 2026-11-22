/**
 * Defect, exploratory-session and task-board rules (pure, no I/O). The server enforces them; the UI mirrors them.
 *  - only a person can move a defect to CLOSED, REJECTED or DUPLICATE, or mark a task COMPLETED
 *  - every defect status change is a person's decision (agents can report defects and comment)
 *  - rejecting, marking duplicate, reopening and closing need a note, so history explains each decision
 */
import type { Actor } from './qa.ts';

export const DEFECT_STATUSES = ['new', 'open', 'in_progress', 'fixed', 'retest', 'reopened', 'closed', 'rejected', 'duplicate'] as const;
export type DefectStatus = (typeof DEFECT_STATUSES)[number];
export const DEFECT_STATUS_LABEL: Record<DefectStatus, string> = {
  new: 'New',
  open: 'Open',
  in_progress: 'In progress',
  fixed: 'Fixed',
  retest: 'Ready to retest',
  reopened: 'Reopened',
  closed: 'Closed',
  rejected: 'Rejected (not a defect)',
  duplicate: 'Duplicate',
};
export const SEVERITIES = ['critical', 'major', 'minor', 'trivial'] as const;
export const DEFECT_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;

const DEFECT_TRANSITIONS: Record<DefectStatus, readonly DefectStatus[]> = {
  new: ['open', 'rejected', 'duplicate'],
  open: ['in_progress', 'rejected', 'duplicate'],
  in_progress: ['fixed', 'open'],
  fixed: ['retest', 'in_progress'],
  retest: ['closed', 'reopened'],
  reopened: ['in_progress', 'rejected', 'duplicate'],
  closed: ['reopened'],
  rejected: ['reopened'],
  duplicate: ['reopened'],
};
export const nextDefectStatuses = (from: DefectStatus): readonly DefectStatus[] => DEFECT_TRANSITIONS[from];
export const FINISHED_DEFECT_STATUSES: readonly DefectStatus[] = ['closed', 'rejected', 'duplicate'];
/** A defect still needs attention. */
export const isOpenDefect = (s: DefectStatus): boolean => !FINISHED_DEFECT_STATUSES.includes(s);
export const DEFECT_NOTE_REQUIRED: readonly DefectStatus[] = ['rejected', 'duplicate', 'reopened', 'closed'];

export type DefectCheck = { ok: true } | { ok: false; code: 'invalid_transition' | 'human_required' | 'note_required'; message: string };

export function checkDefectTransition(from: DefectStatus, to: DefectStatus, actor: Actor, note: string): DefectCheck {
  if (!DEFECT_TRANSITIONS[from].includes(to)) {
    return { ok: false, code: 'invalid_transition', message: `A ${DEFECT_STATUS_LABEL[from].toLowerCase()} defect cannot move to ${DEFECT_STATUS_LABEL[to].toLowerCase()}` };
  }
  if (actor !== 'human') return { ok: false, code: 'human_required', message: 'Only a person can change a defect\'s status' };
  if (DEFECT_NOTE_REQUIRED.includes(to) && !note.trim()) {
    return { ok: false, code: 'note_required', message: `A note is required to mark a defect ${DEFECT_STATUS_LABEL[to].toLowerCase()}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------- exploratory sessions
export const EXPLORATORY_STATUSES = ['planned', 'in_progress', 'completed'] as const;
export const EXPLORATORY_NOTE_KINDS = ['note', 'bug', 'question', 'idea'] as const;
export const EXPLORATORY_KIND_LABEL = { note: 'Note', bug: 'Bug', question: 'Question', idea: 'Idea' } as const;

// ---------------------------------------------------------------------------- task board
export const TASK_STAGES = ['backlog', 'ready', 'in_progress', 'waiting_review', 'blocked', 'completed'] as const;
export type TaskStage = (typeof TASK_STAGES)[number];
export const TASK_STAGE_LABEL: Record<TaskStage, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In progress',
  waiting_review: 'Waiting for review',
  blocked: 'Blocked',
  completed: 'Completed',
};
export const TASK_KINDS = ['test_design', 'execution', 'retest', 'review', 'defect_followup', 'other'] as const;
export const TASK_KIND_LABEL: Record<(typeof TASK_KINDS)[number], string> = {
  test_design: 'Test design',
  execution: 'Execution',
  retest: 'Retest',
  review: 'Review',
  defect_followup: 'Defect follow-up',
  other: 'Other',
};

export type TaskCheck = { ok: true } | { ok: false; code: 'unchanged' | 'human_required' | 'note_required'; message: string };

/** Any stage can be reached from any other (a board is a planning tool), except: only a person completes a task, and blocking or moving a completed task back needs a reason. */
export function checkTaskMove(from: TaskStage, to: TaskStage, actor: Actor, note: string): TaskCheck {
  if (from === to) return { ok: false, code: 'unchanged', message: 'The task is already in that stage' };
  if (to === 'completed' && actor !== 'human') return { ok: false, code: 'human_required', message: 'Only a person can mark a task completed' };
  if ((to === 'blocked' || from === 'completed') && !note.trim()) {
    return { ok: false, code: 'note_required', message: to === 'blocked' ? 'Say what is blocking this task' : 'Say why a completed task is being reopened' };
  }
  return { ok: true };
}
