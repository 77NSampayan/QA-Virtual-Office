/**
 * Manual test execution rules (pure, no I/O). The server enforces them; the UI only mirrors them.
 *  - only a person can record PASSED (also a database constraint)
 *  - FAILED, BLOCKED and SKIPPED need a note saying why
 *  - leaving a finished result (re-testing) needs a note too, so history explains every change
 */
import type { Actor } from './qa.ts';

export const EXECUTION_STATUSES = ['not_run', 'in_progress', 'passed', 'failed', 'blocked', 'skipped'] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const EXECUTION_STATUS_LABEL: Record<ExecutionStatus, string> = {
  not_run: 'Not run',
  in_progress: 'In progress',
  passed: 'Passed',
  failed: 'Failed',
  blocked: 'Blocked',
  skipped: 'Skipped',
};

export const EXECUTOR_KINDS = ['human', 'agent_assisted', 'automated'] as const;
export type ExecutorKind = (typeof EXECUTOR_KINDS)[number];

/** A result that counts in pass/fail figures. */
export const DECIDED_STATUSES: readonly ExecutionStatus[] = ['passed', 'failed', 'blocked', 'skipped'];
export const isDecided = (s: ExecutionStatus): boolean => DECIDED_STATUSES.includes(s);

/** Results an agent may never record. */
export const HUMAN_ONLY_RESULTS: readonly ExecutionStatus[] = ['passed', 'skipped'];
export const NOTE_REQUIRED_RESULTS: readonly ExecutionStatus[] = ['failed', 'blocked', 'skipped'];

export type ExecutionCheck = { ok: true } | { ok: false; code: 'unchanged' | 'human_required' | 'note_required'; message: string };

export function checkExecutionChange(from: ExecutionStatus, to: ExecutionStatus, actor: Actor, note: string): ExecutionCheck {
  if (from === to) return { ok: false, code: 'unchanged', message: 'The result is already set to that value' };
  if (HUMAN_ONLY_RESULTS.includes(to) && actor !== 'human') {
    return { ok: false, code: 'human_required', message: `Only a person can mark a test ${EXECUTION_STATUS_LABEL[to].toUpperCase()}` };
  }
  const hasNote = note.trim().length > 0;
  if (NOTE_REQUIRED_RESULTS.includes(to) && !hasNote) {
    return { ok: false, code: 'note_required', message: `A note is required to mark a test ${EXECUTION_STATUS_LABEL[to].toUpperCase()}` };
  }
  if (isDecided(from) && !hasNote) {
    return { ok: false, code: 'note_required', message: 'A note is required to change a finished result (say why it is being re-tested)' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------- evidence files
export const EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;
export const EVIDENCE_MAX_PER_EXECUTION = 20;

interface EvidenceType {
  mime: string;
  /** Text files are redacted before they are stored; images and PDFs cannot be and are stored as received. */
  text: boolean;
  /** Magic bytes the file must start with (binary types). */
  magic?: number[][];
}
export const EVIDENCE_TYPES: Record<string, EvidenceType> = {
  png: { mime: 'image/png', text: false, magic: [[0x89, 0x50, 0x4e, 0x47]] },
  jpg: { mime: 'image/jpeg', text: false, magic: [[0xff, 0xd8, 0xff]] },
  jpeg: { mime: 'image/jpeg', text: false, magic: [[0xff, 0xd8, 0xff]] },
  gif: { mime: 'image/gif', text: false, magic: [[0x47, 0x49, 0x46, 0x38]] },
  webp: { mime: 'image/webp', text: false, magic: [[0x52, 0x49, 0x46, 0x46]] },
  pdf: { mime: 'application/pdf', text: false, magic: [[0x25, 0x50, 0x44, 0x46]] },
  txt: { mime: 'text/plain', text: true },
  log: { mime: 'text/plain', text: true },
  json: { mime: 'application/json', text: true },
  csv: { mime: 'text/csv', text: true },
};

export function evidenceTypeFor(fileName: string): (EvidenceType & { ext: string }) | null {
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(fileName.trim())?.[1]?.toLowerCase();
  const t = ext ? EVIDENCE_TYPES[ext] : undefined;
  return t && ext ? { ...t, ext } : null;
}

export function matchesMagic(type: EvidenceType, bytes: Uint8Array): boolean {
  if (!type.magic) return true;
  return type.magic.some((m) => m.every((b, i) => bytes[i] === b));
}

/** A display-safe file name: no directories, no control characters, bounded length. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim();
  return (cleaned || 'file').slice(0, 120);
}
