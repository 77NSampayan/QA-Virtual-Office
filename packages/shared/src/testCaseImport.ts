/**
 * Test-case table importer (pure, no I/O): reads a Markdown pipe table OR a tab-separated table pasted from a
 * spreadsheet, and maps the columns of the team's test-case template onto the app's test-case fields.
 *
 * What it deliberately does NOT import: execution results (Actual Result, Status, Test Execution Status, dates,
 * defect ids, evidence links, automation columns...). A result only counts when a person records it in the
 * execution board, so an imported "Passed" never becomes a result. Those columns are reported as ignored.
 * Nothing is interpreted by AI; unknown values fall back to a documented default and raise a visible warning.
 */
import { PRIORITIES, TEST_TYPES, TEST_TYPE_LABEL, type Priority, type TestType } from './qa.ts';

export const MAX_IMPORT_ROWS = 1000;

export interface ParsedTestCaseRow {
  /** 1-based position of the row in the table (header excluded), for messages. */
  row: number;
  externalId: string;
  module: string;
  subModule: string;
  title: string;
  description: string;
  preconditions: string;
  steps: string[];
  testData: string;
  expectedResult: string;
  priority: Priority;
  testType: TestType;
  assignedTester: string;
  requirementRefs: string[];
  warnings: string[];
}
export interface ImportColumns {
  /** Header names (as written) that were mapped to a test-case field. */
  recognised: string[];
  /** Known template columns that hold execution/automation data: never imported. */
  ignored: string[];
  /** Headers this importer does not know: never imported. */
  unknown: string[];
}
export interface ParsedTestCases {
  format: 'markdown' | 'tsv' | 'none';
  columns: ImportColumns;
  rows: ParsedTestCaseRow[];
  rowErrors: Array<{ row: number; reason: string }>;
  /** True when no header carries the test-case description (the only required column). */
  missingDescriptionColumn: boolean;
  /** More rows than MAX_IMPORT_ROWS were found; the extra rows were not read. */
  truncated: boolean;
}

type Field =
  | 'externalId'
  | 'module'
  | 'subModule'
  | 'title'
  | 'preconditions'
  | 'steps'
  | 'testData'
  | 'expectedResult'
  | 'priority'
  | 'testType'
  | 'assignedTester'
  | 'requirements'
  | 'remarks';

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

const FIELD_OF: Record<string, Field> = {
  testcaseid: 'externalId', tcid: 'externalId', id: 'externalId', testid: 'externalId', testcaseno: 'externalId', testcasenumber: 'externalId',
  module: 'module',
  submodule: 'subModule',
  testcasedescription: 'title', testcasetitle: 'title', title: 'title', description: 'title', testcase: 'title', testcasename: 'title', testscenario: 'title',
  testcasetype: 'testType', type: 'testType', testtype: 'testType',
  precondition: 'preconditions', preconditions: 'preconditions',
  steps: 'steps', teststeps: 'steps', testcasesteps: 'steps', stepstoreproduce: 'steps',
  expectedresult: 'expectedResult', expectedresults: 'expectedResult', expected: 'expectedResult',
  testdata: 'testData',
  assignedtester: 'assignedTester', tester: 'assignedTester', assignedto: 'assignedTester',
  priority: 'priority',
  requirement: 'requirements', requirements: 'requirements', requirementref: 'requirements', requirementrefs: 'requirements', requirementid: 'requirements', requirementids: 'requirements', reqref: 'requirements', reqrefs: 'requirements', traceability: 'requirements',
  remarks: 'remarks', remark: 'remarks', notes: 'remarks', note: 'remarks',
};
/** Execution / automation / defect columns of the template: reported as ignored, never stored. */
const IGNORED_EXACT = new Set([
  'actualresult', 'deexceptionmessage', 'status', 'testexecutionstatus', 'proposedsolution', 'actionowner', 'actionitem', 'testevidencelink', 'testinclusion', 'defectid', 'defecthistory',
]);
const isIgnored = (n: string) => IGNORED_EXACT.has(n) || n.startsWith('executiondate') || n.startsWith('automation');

// ---------------------------------------------------------------------------- table readers
function splitPipeRow(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '\\' && line[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '|') {
      cells.push(cur);
      cur = '';
    } else cur += c;
  }
  cells.push(cur);
  if (cells.length && cells[0]!.trim() === '') cells.shift(); // leading pipe
  if (cells.length && cells[cells.length - 1]!.trim() === '') cells.pop(); // trailing pipe
  return cells.map((c) => c.trim());
}
const SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Every Markdown pipe table in the text: a header row, a separator row, then the body rows. */
function readMarkdownTables(text: string): string[][][] {
  const lines = text.split(/\r?\n/);
  const tables: string[][][] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i]!.includes('|') || !SEPARATOR.test(lines[i + 1]!) || !lines[i + 1]!.includes('-')) continue;
    const table: string[][] = [splitPipeRow(lines[i]!)];
    let j = i + 2;
    while (j < lines.length && lines[j]!.trim() !== '' && lines[j]!.includes('|')) table.push(splitPipeRow(lines[j++]!));
    tables.push(table);
    i = j;
  }
  return tables;
}

/** Tab-separated records with spreadsheet-style quoting ("..." may contain tabs, line breaks and "" for a quote). */
function readTsv(text: string): string[][] {
  const records: string[][] = [];
  let rec: string[] = [];
  let cur = '';
  let quoted = false;
  const s = text.replace(/\r\n?/g, '\n');
  const endField = () => {
    rec.push(cur);
    cur = '';
  };
  const endRecord = () => {
    endField();
    if (rec.some((c) => c.trim() !== '')) records.push(rec.map((c) => c.trim()));
    rec = [];
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"' && cur === '') quoted = true;
    else if (c === '\t') endField();
    else if (c === '\n') endRecord();
    else cur += c;
  }
  endRecord();
  return records;
}

// ---------------------------------------------------------------------------- value mapping
const cleanCell = (v: string | undefined) => (v ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/\r\n?/g, '\n').trim();

const TYPE_ALIASES: Record<string, TestType> = {
  bva: 'boundary_value', boundary: 'boundary_value', boundaryvalue: 'boundary_value', boundaryvalueanalysis: 'boundary_value',
  ep: 'equivalence_partitioning', equivalencepartitioning: 'equivalence_partitioning', equivalence: 'equivalence_partitioning',
  e2e: 'end_to_end', endtoend: 'end_to_end',
  decisiontable: 'decision_table', statetransition: 'state_transition',
};
for (const t of TEST_TYPES) {
  TYPE_ALIASES[norm(t)] = t;
  TYPE_ALIASES[norm(TEST_TYPE_LABEL[t])] = t;
}
const PRIORITY_ALIASES: Record<string, Priority> = { blocker: 'critical', p1: 'critical', major: 'high', p2: 'high', normal: 'medium', p3: 'medium', minor: 'low', p4: 'low' };
for (const p of PRIORITIES) PRIORITY_ALIASES[p] = p;

/** One step per line; leading numbering/bullets are removed; "1. a 2. b 3. c" on one line is split. */
export function splitSteps(cell: string): string[] {
  let parts = cell.replace(/<br\s*\/?>/gi, '\n').split('\n').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 1 && /^\s*(step\s*)?1\s*[.):-]\s.*\s2\s*[.):-]\s/i.test(parts[0]!)) parts = parts[0]!.split(/(?<!\bstep)\s+(?=(?:step\s*)?\d{1,2}\s*[.):-]\s)/i);
  return parts.map((s) => s.replace(/^\s*(?:step\s*)?\d{1,2}\s*[.):-]\s*/i, '').replace(/^[-*•]\s+/, '').trim()).filter(Boolean);
}
const splitRefs = (cell: string) => [...new Set(cell.split(/[\s,;/]+/).map((r) => r.trim()).filter(Boolean))];
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

function mapRows(table: string[][], offset: number, out: ParsedTestCases, seenHeader: { recognised: Set<string>; ignored: Set<string>; unknown: Set<string> }) {
  const header = table[0]!;
  const fieldAt: Array<Field | null> = header.map((h) => {
    const n = norm(h);
    const field = FIELD_OF[n];
    if (field) seenHeader.recognised.add(h);
    else if (isIgnored(n)) seenHeader.ignored.add(h);
    else if (n) seenHeader.unknown.add(h);
    return field ?? null;
  });
  if (!fieldAt.includes('title')) {
    out.missingDescriptionColumn = out.missingDescriptionColumn || out.rows.length === 0;
    return offset;
  }
  out.missingDescriptionColumn = false;
  let row = offset;
  for (const cells of table.slice(1)) {
    if (out.rows.length >= MAX_IMPORT_ROWS) {
      out.truncated = true;
      break;
    }
    row++;
    const get = (f: Field) => cleanCell(cells[fieldAt.indexOf(f)]);
    const has = (f: Field) => fieldAt.includes(f);
    const description = has('title') ? get('title') : '';
    if (!description) {
      if (cells.some((c) => cleanCell(c))) out.rowErrors.push({ row, reason: 'The test case description is empty' });
      continue;
    }
    const warnings: string[] = [];
    const rawType = has('testType') ? get('testType') : '';
    let testType: TestType = 'positive';
    if (rawType) {
      const t = TYPE_ALIASES[norm(rawType)];
      if (t) testType = t;
      else warnings.push(`Type "${clip(rawType, 40)}" is not one of the app's types, so Positive was used`);
    }
    const rawPriority = has('priority') ? get('priority') : '';
    let priority: Priority = 'medium';
    if (rawPriority) {
      const p = PRIORITY_ALIASES[norm(rawPriority)];
      if (p) priority = p;
      else warnings.push(`Priority "${clip(rawPriority, 40)}" is not recognised, so Medium was used`);
    }
    const firstLine = description.split('\n')[0]!.trim();
    const long = description.includes('\n') || description.length > 200;
    const remarks = has('remarks') ? get('remarks') : '';
    const fullDescription = [long ? description : '', remarks ? `Remarks: ${remarks}` : ''].filter(Boolean).join('\n\n');
    out.rows.push({
      row,
      externalId: has('externalId') ? get('externalId').slice(0, 60) : '',
      module: get('module'),
      subModule: get('subModule'),
      title: clip(firstLine, 200),
      description: fullDescription,
      preconditions: get('preconditions'),
      steps: has('steps') ? splitSteps(get('steps')) : [],
      testData: get('testData'),
      expectedResult: get('expectedResult'),
      priority,
      testType,
      assignedTester: get('assignedTester').slice(0, 100),
      requirementRefs: has('requirements') ? splitRefs(get('requirements')) : [],
      warnings,
    });
  }
  return row;
}

export function parseTestCaseTable(input: string): ParsedTestCases {
  const out: ParsedTestCases = {
    format: 'none',
    columns: { recognised: [], ignored: [], unknown: [] },
    rows: [],
    rowErrors: [],
    missingDescriptionColumn: false,
    truncated: false,
  };
  const seen = { recognised: new Set<string>(), ignored: new Set<string>(), unknown: new Set<string>() };
  const md = readMarkdownTables(input);
  let offset = 0;
  if (md.length) {
    out.format = 'markdown';
    for (const t of md) offset = mapRows(t, offset, out, seen);
  } else if (input.includes('\t')) {
    const records = readTsv(input);
    if (records.length >= 1) {
      out.format = 'tsv';
      mapRows(records, 0, out, seen);
    }
  }
  out.columns = { recognised: [...seen.recognised], ignored: [...seen.ignored], unknown: [...seen.unknown] };
  return out;
}
