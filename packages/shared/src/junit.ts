/**
 * JUnit XML reader (browser-safe, no dependencies). JUnit XML is what pytest, Robot Framework, Playwright, Maven,
 * Jest (jest-junit) and most CI tools export, so one reader covers them all.
 *
 * Deliberately small and defensive, because the file comes from outside:
 *  - it is NOT an XML parser: DOCTYPE/entity declarations are skipped and never expanded (no XXE, no entity bombs);
 *    only the five standard entities and numeric references are decoded, inside attribute values
 *  - text bodies are never read: stack traces, logs (system-out/system-err) and attachments are dropped by design
 *  - only names, status, duration and a short first line of the failure message are kept
 */
import { redact } from './redact.ts';

export type AutomationStatus = 'passed' | 'failed' | 'error' | 'skipped';
export const AUTOMATION_STATUSES: readonly AutomationStatus[] = ['passed', 'failed', 'error', 'skipped'];

export interface JunitCase {
  suite: string;
  className: string;
  name: string;
  status: AutomationStatus;
  durationMs: number;
  /** First line of the failure/error/skip message, redacted and capped; '' for a pass. */
  message: string;
}
export interface JunitResult {
  cases: JunitCase[];
  /** Set when there were more test cases than the cap. */
  truncated: boolean;
  /** Plain-language problems; empty when the file read cleanly. */
  problems: string[];
}

export const JUNIT_MAX_CASES = 20_000;
export const JUNIT_MAX_BYTES = 5 * 1024 * 1024;
const NAME_MAX = 300;
const MESSAGE_MAX = 300;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m; // an unknown entity stays as written; it is never expanded
  });
}

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const clean = (s: string, n: number) => cap(redact(s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim()), n);
const firstLine = (s: string) => s.split(/\r?\n/, 1)[0] ?? '';

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) out[m[1]!.toLowerCase()] = decode(m[2] ?? m[3] ?? '');
  return out;
}

export function parseJunit(input: string): JunitResult {
  const problems: string[] = [];
  const cases: JunitCase[] = [];
  let truncated = false;
  if (!input.trim()) return { cases, truncated, problems: ['The file is empty.'] };
  // Drop everything we never read, so its content cannot confuse the tag scan: comments, CDATA, processing
  // instructions and DOCTYPE (no expansion of anything).
  const text = input
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>/gi, '');
  const tagRe = /<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

  const suites: string[] = [];
  let current: { c: JunitCase; open: boolean } | null = null;
  let sawSuite = false;
  const finish = () => {
    if (!current) return;
    if (cases.length >= JUNIT_MAX_CASES) truncated = true;
    else cases.push(current.c);
    current = null;
  };
  for (let m = tagRe.exec(text); m; m = tagRe.exec(text)) {
    const closing = m[1] === '/';
    const tag = m[2]!.toLowerCase();
    const rawAttrs = m[3] ?? '';
    const selfClosing = /\/\s*$/.test(rawAttrs);
    if (tag === 'testsuite') {
      sawSuite = true;
      if (closing) suites.pop();
      else if (!selfClosing) suites.push(clean(attrs(rawAttrs).name ?? '', NAME_MAX));
      continue;
    }
    if (tag === 'testcase') {
      if (closing) {
        finish();
        continue;
      }
      finish();
      const a = attrs(rawAttrs);
      const seconds = Number.parseFloat(a.time ?? '0');
      current = {
        c: {
          suite: suites[suites.length - 1] ?? '',
          className: clean(a.classname ?? '', NAME_MAX),
          name: clean(a.name ?? '', NAME_MAX) || '(unnamed)',
          status: 'passed',
          durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.round(seconds * 1000), 7 * 24 * 3600_000) : 0,
          message: '',
        },
        open: !selfClosing,
      };
      if (selfClosing) finish();
      continue;
    }
    if (!current || closing) continue;
    if (tag === 'failure' || tag === 'error' || tag === 'skipped') {
      const status: AutomationStatus = tag === 'failure' ? 'failed' : tag === 'error' ? 'error' : 'skipped';
      // a real failure outranks a skip if a file (wrongly) holds both
      if (current.c.status === 'passed' || (current.c.status === 'skipped' && status !== 'skipped')) {
        current.c.status = status;
        const a = attrs(rawAttrs);
        current.c.message = clean(firstLine(a.message ?? a.type ?? ''), MESSAGE_MAX);
      }
    }
  }
  finish();
  if (!sawSuite && cases.length === 0) problems.push('No <testsuite> or <testcase> elements were found. This does not look like JUnit XML.');
  else if (cases.length === 0) problems.push('The file has test suites but no test cases.');
  if (truncated) problems.push(`Only the first ${JUNIT_MAX_CASES} test cases were read.`);
  return { cases, truncated, problems };
}

export interface AutomationCounts {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
}
export function countStatuses(cases: ReadonlyArray<{ status: AutomationStatus }>): AutomationCounts {
  const c: AutomationCounts = { total: cases.length, passed: 0, failed: 0, errored: 0, skipped: 0 };
  for (const x of cases) {
    if (x.status === 'passed') c.passed++;
    else if (x.status === 'failed') c.failed++;
    else if (x.status === 'error') c.errored++;
    else c.skipped++;
  }
  return c;
}
/** Pass rate = passed / (passed + failed + errored). Skipped tests are not in the denominator. */
export const automationDenominator = (c: AutomationCounts) => c.passed + c.failed + c.errored;

export const AUTOMATION_CLASSIFICATIONS = ['unknown', 'product_defect', 'test_issue', 'environment', 'flaky'] as const;
export type AutomationClassification = (typeof AUTOMATION_CLASSIFICATIONS)[number];
export const AUTOMATION_CLASSIFICATION_LABEL: Record<AutomationClassification, string> = {
  unknown: 'Unknown (not yet classified)',
  product_defect: 'Product defect',
  test_issue: 'Test issue',
  environment: 'Environment',
  flaky: 'Flaky',
};
