/**
 * Manual QA domain rules (browser-safe, pure): enums, the test-case approval workflow, requirements
 * text parsing, deterministic ambiguity hints and coverage ratios.
 *
 * Principles (docs/privacy.md and the product spec):
 *  - only a HUMAN may approve or reject a test case (enforced again in the server service layer)
 *  - requirements are never assumed correct: ambiguity hints are raised for human review
 *  - a percentage is only produced together with its numerator and denominator
 */

export const ACTORS = ['human', 'agent', 'system'] as const;
export type Actor = (typeof ACTORS)[number];

export const TEST_CASE_STATUSES = ['draft', 'in_review', 'approved', 'rejected'] as const;
export type TestCaseStatus = (typeof TEST_CASE_STATUSES)[number];

export const TEST_CASE_STATUS_LABEL: Record<TestCaseStatus, string> = {
  draft: 'Draft',
  in_review: 'In review',
  approved: 'Approved',
  rejected: 'Rejected',
};

const TRANSITIONS: Record<TestCaseStatus, readonly TestCaseStatus[]> = {
  draft: ['in_review'],
  in_review: ['approved', 'rejected', 'draft'],
  rejected: ['draft'],
  approved: ['draft'],
};
export const canTransition = (from: TestCaseStatus, to: TestCaseStatus): boolean => TRANSITIONS[from].includes(to);
export const nextStatuses = (from: TestCaseStatus): readonly TestCaseStatus[] => TRANSITIONS[from];

/** Transitions that express a decision and therefore need a human. */
export const HUMAN_ONLY_TARGETS: readonly TestCaseStatus[] = ['approved', 'rejected'];

export const TEST_TYPES = [
  'positive',
  'negative',
  'boundary_value',
  'equivalence_partitioning',
  'decision_table',
  'state_transition',
  'exploratory',
  'regression',
  'integration',
  'end_to_end',
] as const;
export type TestType = (typeof TEST_TYPES)[number];

export const TEST_TYPE_LABEL: Record<TestType, string> = {
  positive: 'Positive',
  negative: 'Negative',
  boundary_value: 'Boundary value analysis',
  equivalence_partitioning: 'Equivalence partitioning',
  decision_table: 'Decision table',
  state_transition: 'State transition',
  exploratory: 'Exploratory',
  regression: 'Regression',
  integration: 'Integration',
  end_to_end: 'End-to-end',
};

export const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const REQUIREMENT_KINDS = ['brd', 'fsd', 'user_story', 'acceptance_criteria', 'other'] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];
export const REQUIREMENT_KIND_LABEL: Record<RequirementKind, string> = {
  brd: 'BRD',
  fsd: 'FSD',
  user_story: 'User story',
  acceptance_criteria: 'Acceptance criteria',
  other: 'Other',
};

export const REVIEW_STATUSES = ['unreviewed', 'reviewed', 'needs_clarification'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const FLAG_TYPES = ['ambiguity', 'gap', 'conflict', 'other'] as const;
export type FlagType = (typeof FLAG_TYPES)[number];
export const FLAG_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type FlagStatus = (typeof FLAG_STATUSES)[number];

// ---------------------------------------------------------------------------- approval rules
export interface ApprovalCandidate {
  title: string;
  steps: readonly string[];
  expectedResult: string;
}

/** Codes of what is missing before a test case can be approved (empty = ready). */
export function validateForApproval(tc: ApprovalCandidate): string[] {
  const missing: string[] = [];
  if (!tc.title.trim()) missing.push('title_required');
  if (!tc.steps.some((s) => s.trim())) missing.push('steps_required');
  if (!tc.expectedResult.trim()) missing.push('expected_result_required');
  return missing;
}

// ---------------------------------------------------------------------------- coverage
export interface Ratio {
  numerator: number;
  denominator: number;
  /** One decimal place; null when the denominator is 0 (a percentage would be meaningless). */
  percent: number | null;
}

export function coverageRatio(numerator: number, denominator: number): Ratio {
  const n = Math.max(0, Math.min(numerator, Math.max(denominator, 0)));
  return {
    numerator: denominator > 0 ? n : Math.max(0, numerator),
    denominator,
    percent: denominator > 0 ? Math.round((n / denominator) * 1000) / 10 : null,
  };
}

// ---------------------------------------------------------------------------- requirements parsing
export interface ParsedRequirement {
  ref: string;
  /** Letters before the first digit/separator, upper case (BR, FR, NFR, AC, US ...); '' for dotted numbers. */
  prefix: string;
  title: string;
  text: string;
}
export interface ParsedRequirements {
  items: ParsedRequirement[];
  /** Lines before the first requirement that could not be attributed to one. */
  unparsed: string[];
  /** References that occur more than once in the pasted text (the first definition is the richer one). */
  duplicates: string[];
}

const ID = String.raw`[A-Za-z]{1,6}-\d+(?:[.-]\d+)*`;
const ID_ONLY = new RegExp(`^${ID}$`);
/** `- **OBJ-01** text`, `**FR-01 Registration** (Guest)`, `**BRL-01:** text` */
const BOLD_ID_LINE = new RegExp(String.raw`^\s*(?:[-*•]\s*|\d+[.)]\s+)?\*\*\s*(${ID})\b[:.]?\s*(.*)$`);
/** Heading text that starts with an id: `FR-03 Logout`, `**FR-03** Logout` */
const HEADING_ID = new RegExp(String.raw`^(?:\*\*)?\s*(${ID})\b(?:\*\*)?[:.]?\s*(.*)$`);
/** `REQ-1: text`, `US-12 - text`, `BRD 3.2) text`, `- FR-7. text` */
const REF_LINE = /^\s*(?:[-*•]\s*)?(?:\*\*)?([A-Za-z]{1,6}[-_ ]?\d+(?:[.-]\d+)*)(?:\*\*)?\s*[:.)\-–—]\s*(.+)$/;
const NUMBERED_LINE = /^\s*(\d+(?:\.\d+)+)\s+(.+)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const TITLE_MAX = 120;
const UNPARSED_MAX = 200;

const clean = (s: string) => s.replace(/\*\*/g, '').replace(/`/g, '').trim();

function titleOf(text: string, fallback: string): string {
  const first = text.split('\n')[0]!.trim() || fallback;
  return first.length <= TITLE_MAX ? first : first.slice(0, TITLE_MAX - 1).trimEnd() + '…';
}

/** Picks the requirement sentence from a table row: Given/When/Then columns, else a requirement-like column, else the 2nd cell. */
function tableMain(cells: string[], headers: string[]): { main: string; used: Set<number> } {
  const idx = (re: RegExp) => headers.findIndex((h, i) => i > 0 && re.test(h.trim()));
  const g = idx(/^given$/i);
  const w = idx(/^when$/i);
  const t = idx(/^then$/i);
  if (g > 0 && w > 0 && t > 0 && cells[g] && cells[w] && cells[t]) {
    return { main: `Given ${cells[g]}, when ${cells[w]}, then ${cells[t]}`, used: new Set([g, w, t]) };
  }
  const r = idx(/(requirement|statement|description|rule|text)/i);
  const i = r > 0 && cells[r] ? r : 1;
  return { main: cells[i] ?? '', used: new Set([i]) };
}

const prefixOf = (ref: string) => /^([A-Za-z]+)/.exec(ref)?.[1]?.toUpperCase() ?? '';

/**
 * Splits BRD / FSD / user-story text (plain lists or markdown) into requirement candidates.
 * Deterministic: no AI involved. Recognised layouts:
 *  - tables whose first cell is an id (other columns become "Header: value" lines)
 *  - bold ids in bullets or titles (`- **OBJ-01** text`, `**FR-01 Title**` + numbered rules)
 *  - headings that start with an id (`#### FR-03 Logout`)
 *  - `REQ-1: text`, `US-12 - text`, `BRD 3.2) text`, dotted numbers (`4.1 text`)
 * A section heading ends the previous requirement. Tables without an id in the first cell are ignored.
 */
export function parseRequirements(input: string): ParsedRequirements {
  const items: ParsedRequirement[] = [];
  const unparsed: string[] = [];
  let current: { ref: string; lines: string[] } | null = null;
  let headers: string[] = [];
  let lastRow: string[] = [];

  const flush = () => {
    if (current) {
      const text = current.lines.join('\n').trim();
      items.push({ ref: current.ref, prefix: prefixOf(current.ref), title: titleOf(text, current.ref), text });
    }
    current = null;
  };
  const start = (ref: string, first: string) => {
    flush();
    const f = clean(first);
    current = { ref: clean(ref).replace(/_/g, '-'), lines: f ? [f] : [] };
  };

  const lines = input.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!.trimEnd();
    if (!line.trim()) continue;

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      headers = [];
      const h = HEADING_ID.exec(heading[1]!.trim());
      if (h) start(h[1]!, h[2]!);
      continue;
    }

    if (TABLE_SEPARATOR.test(line)) {
      headers = lastRow; // the row just above a separator is the header row
      continue;
    }
    if (TABLE_ROW.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(clean);
      lastRow = cells;
      const nextLine = lines.slice(li + 1).find((l) => l.trim());
      if (nextLine !== undefined && TABLE_SEPARATOR.test(nextLine)) {
        flush(); // a table header starts a new table: it ends the requirement above it
        continue;
      }
      if (ID_ONLY.test(cells[0] ?? '')) {
        flush(); // a table row is a complete requirement on its own
        const { main, used } = tableMain(cells, headers);
        const extra = cells
          .map((v, i) => ({ h: headers[i] ?? '', v, i }))
          .filter((c) => c.i > 0 && !used.has(c.i) && c.h && c.v && c.v !== '—' && c.v !== '-')
          .map((c) => `${c.h}: ${c.v}`);
        current = { ref: cells[0]!, lines: [main, ...extra].filter(Boolean) };
        flush();
      } else if (current) {
        (current as { lines: string[] }).lines.push(line.trim()); // e.g. a message table inside a functional requirement
      }
      continue;
    }

    const bold = BOLD_ID_LINE.exec(line);
    if (bold) {
      start(bold[1]!, bold[2]!);
      continue;
    }
    const m = REF_LINE.exec(line) ?? NUMBERED_LINE.exec(line);
    if (m) {
      start(m[1]!, m[2]!);
    } else if (current) {
      (current as { lines: string[] }).lines.push(line.trim());
    } else if (items.length === 0 && unparsed.length < UNPARSED_MAX) {
      unparsed.push(line.trim());
    }
  }
  flush();

  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.ref.toLowerCase(), (counts.get(i.ref.toLowerCase()) ?? 0) + 1);
  const duplicates = [...new Set(items.filter((i) => (counts.get(i.ref.toLowerCase()) ?? 0) > 1).map((i) => i.ref))];
  return { items, unparsed, duplicates };
}

/** Document kind implied by a reference prefix (used by "detect from the reference"). */
export function inferKind(ref: string): RequirementKind {
  switch (prefixOf(ref)) {
    case 'BR':
    case 'BRL':
    case 'BRD':
    case 'OBJ':
      return 'brd';
    case 'FR':
    case 'NFR':
    case 'VR':
    case 'FSD':
      return 'fsd';
    case 'AC':
      return 'acceptance_criteria';
    case 'US':
      return 'user_story';
    default:
      return 'other';
  }
}

// ---------------------------------------------------------------------------- ambiguity hints
export type HintKind = 'vague' | 'placeholder' | 'weak_modal' | 'unmeasurable';
export interface AmbiguityFinding {
  kind: HintKind;
  term: string;
  note: string;
}

const VAGUE = [
  'user-friendly', 'intuitive', 'easy', 'easily', 'simple', 'efficient', 'efficiently', 'robust', 'flexible', 'scalable', 'appropriate',
  'appropriately', 'properly', 'adequate', 'adequately', 'reasonable', 'sufficient', 'significant', 'significantly', 'several', 'various',
  'some', 'many', 'few', 'minimal', 'approximately', 'as needed', 'if possible', 'where possible', 'and/or', 'etc',
];
const PLACEHOLDERS = ['TBD', 'TBC', 'TBA', 'to be determined', 'to be confirmed', 'to be decided'];
const WEAK_MODALS = ['may', 'might', 'could', 'possibly', 'probably'];
/** Performance words that need a number to be testable. */
const UNMEASURABLE = ['fast', 'quick', 'quickly', 'slow', 'responsive', 'immediately', 'instantly', 'real-time', 'high performance'];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (term: string) => new RegExp(`(?<![\\w-])${escape(term)}(?![\\w-])`, 'i');

/**
 * Hints for a human reviewer. These are NOT verdicts: a flagged requirement may be fine and an
 * unflagged one may still be wrong. Each term is reported once, in a stable order.
 */
export function analyzeRequirement(text: string): AmbiguityFinding[] {
  const out: AmbiguityFinding[] = [];
  const seen = new Set<string>();
  const add = (kind: HintKind, term: string, note: string) => {
    const key = `${kind}:${term.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ kind, term, note });
    }
  };
  const hasNumber = /\d/.test(text);
  for (const t of PLACEHOLDERS) if (wordRe(t).test(text)) add('placeholder', t, `"${t}" marks something that is not decided yet; the requirement cannot be tested until it is.`);
  for (const t of UNMEASURABLE) if (wordRe(t).test(text) && !hasNumber) add('unmeasurable', t, `"${t}" has no measurable target (no number in the requirement), so a tester cannot decide pass or fail.`);
  for (const t of VAGUE) if (wordRe(t).test(text)) add('vague', t, `"${t}" is open to interpretation; ask what exactly is expected.`);
  for (const t of WEAK_MODALS) if (wordRe(t).test(text)) add('weak_modal', t, `"${t}" does not say whether the behaviour is required; clarify "shall" versus "may".`);
  return out;
}
