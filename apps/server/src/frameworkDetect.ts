/**
 * Test framework detection (Pass 3, A2). READ-ONLY and deliberately narrow:
 *  - runs only when a person presses "Scan project", on that registered project's folder, never on its own
 *  - looks at file NAMES, and reads only a few small dependency manifests (package.json, requirements*.txt,
 *    pyproject.toml, pom.xml, build.gradle) to find dependency names and declared versions
 *  - never reads source files, tests, .env files or anything else; never follows links; never writes
 *  - reports framework, evidence kind, file base name and declared version only (no paths, no file contents)
 *  - bounded: shallow depth, few entries, small files, a time limit
 */
import fs from 'node:fs';
import path from 'node:path';

export type FrameworkId = 'playwright' | 'cypress' | 'selenium' | 'webdriverio' | 'testcafe' | 'jest' | 'vitest' | 'mocha' | 'pytest' | 'robot' | 'junit' | 'testng';

export interface FrameworkInfo {
  label: string;
  language: string;
  /** How to get a JUnit XML file out of it, for the Import results box. */
  exportHint: string;
}
export const FRAMEWORKS: Record<FrameworkId, FrameworkInfo> = {
  playwright: { label: 'Playwright', language: 'JavaScript/TypeScript, Python or Java', exportHint: "Use the junit reporter: npx playwright test --reporter=junit (set PLAYWRIGHT_JUNIT_OUTPUT_FILE=results.xml)" },
  cypress: { label: 'Cypress', language: 'JavaScript/TypeScript', exportHint: 'Add the mocha-junit-reporter package and run with --reporter mocha-junit-reporter' },
  selenium: { label: 'Selenium', language: 'Java, Python or JavaScript', exportHint: 'Selenium runs inside a test runner (JUnit, TestNG, pytest, Mocha): export JUnit XML from that runner' },
  webdriverio: { label: 'WebdriverIO', language: 'JavaScript/TypeScript', exportHint: 'Add @wdio/junit-reporter and list it in the reporters setting' },
  testcafe: { label: 'TestCafe', language: 'JavaScript/TypeScript', exportHint: 'Run with --reporter xunit:results.xml' },
  jest: { label: 'Jest', language: 'JavaScript/TypeScript', exportHint: 'Add the jest-junit package and run with --reporters=jest-junit' },
  vitest: { label: 'Vitest', language: 'JavaScript/TypeScript', exportHint: 'Run with --reporter=junit --outputFile=results.xml' },
  mocha: { label: 'Mocha', language: 'JavaScript', exportHint: 'Add mocha-junit-reporter and run with --reporter mocha-junit-reporter' },
  pytest: { label: 'pytest', language: 'Python', exportHint: 'Run with --junitxml=results.xml' },
  robot: { label: 'Robot Framework', language: 'Robot / Python', exportHint: 'Run with --xunit results.xml (Robot writes a JUnit-style file)' },
  junit: { label: 'JUnit (Maven/Gradle)', language: 'Java/Kotlin', exportHint: 'The build already writes JUnit XML: target/surefire-reports (Maven) or build/test-results/test (Gradle)' },
  testng: { label: 'TestNG', language: 'Java', exportHint: 'Maven surefire writes JUnit XML into target/surefire-reports; use those files' },
};

export interface Evidence {
  kind: 'config_file' | 'dependency' | 'test_files';
  /** Base name of the file (never a path). */
  file: string;
  where: 'project root' | 'subfolder';
  /** Declared version or range, or a short note such as "3 files". */
  detail: string;
}
export interface DetectedFramework {
  id: FrameworkId;
  label: string;
  language: string;
  exportHint: string;
  /** 'config' = a config file exists; 'dependency' = declared in a manifest; 'files' = only matching test files. */
  confidence: 'config' | 'dependency' | 'files';
  evidence: Evidence[];
}
export interface DetectionResult {
  frameworks: DetectedFramework[];
  scanned: { folders: number; files: number; manifestsRead: number; truncated: boolean };
  notes: string[];
}

// ---------------------------------------------------------------------------- manifest readers (pure, tested)
const dep = (id: FrameworkId, version: string | null) => ({ id, version: version ?? '' });

const NPM: Record<string, FrameworkId> = {
  '@playwright/test': 'playwright',
  playwright: 'playwright',
  cypress: 'cypress',
  'selenium-webdriver': 'selenium',
  webdriverio: 'webdriverio',
  '@wdio/cli': 'webdriverio',
  testcafe: 'testcafe',
  jest: 'jest',
  vitest: 'vitest',
  mocha: 'mocha',
};
export function parsePackageJson(text: string): Array<{ id: FrameworkId; version: string }> {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return [];
  }
  const out: Array<{ id: FrameworkId; version: string }> = [];
  if (!j || typeof j !== 'object') return out;
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = (j as Record<string, unknown>)[section];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, ver] of Object.entries(deps as Record<string, unknown>)) {
      const id = NPM[name];
      if (id && !out.some((o) => o.id === id)) out.push(dep(id, typeof ver === 'string' ? ver.slice(0, 40) : ''));
    }
  }
  return out;
}

const PY: Array<[RegExp, FrameworkId]> = [
  [/^pytest(-[a-z0-9-]+)?$/, 'pytest'],
  [/^robotframework(-[a-z0-9-]+)?$/, 'robot'],
  [/^selenium$/, 'selenium'],
  [/^playwright$/, 'playwright'],
  [/^pytest-playwright$/, 'playwright'],
];
export function parseRequirements(text: string): Array<{ id: FrameworkId; version: string }> {
  const out: Array<{ id: FrameworkId; version: string }> = [];
  for (const raw of text.split(/\r?\n/).slice(0, 2000)) {
    const line = raw.split('#')[0]!.trim();
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*((?:==|>=|<=|~=|!=|>|<)[^;,\s]*)?/.exec(line);
    if (!m) continue;
    const name = m[1]!.toLowerCase().replace(/[._]/g, '-');
    const main = name === 'pytest' || name === 'robotframework' || name === 'selenium' || name === 'playwright';
    for (const [re, id] of PY) {
      if (!re.test(name)) continue;
      const existing = out.find((o) => o.id === id);
      // "pytest-xdist" and friends count as pytest; only the main package line carries the version
      if (!existing) out.push(dep(id, main ? m[2] ?? '' : ''));
      else if (main && !existing.version) existing.version = m[2] ?? '';
    }
  }
  return out;
}

export function parsePyproject(text: string): Array<{ id: FrameworkId; version: string }> {
  const out: Array<{ id: FrameworkId; version: string }> = [];
  const t = text.slice(0, 200_000);
  const add = (id: FrameworkId, v = '') => !out.some((o) => o.id === id) && out.push(dep(id, v));
  if (/^\s*\[tool\.pytest/m.test(t)) add('pytest');
  const has = (name: string) => new RegExp(`["'\\s]${name}(?=[\\s"'<>=~!\\[,;])`, 'i').exec(t);
  if (has('pytest')) add('pytest');
  if (has('robotframework')) add('robot');
  if (has('selenium')) add('selenium');
  if (has('playwright') || has('pytest-playwright')) add('playwright');
  return out;
}

export function parsePomOrGradle(text: string): Array<{ id: FrameworkId; version: string }> {
  const t = text.slice(0, 400_000);
  const out: Array<{ id: FrameworkId; version: string }> = [];
  const add = (id: FrameworkId) => !out.some((o) => o.id === id) && out.push(dep(id, ''));
  if (/selenium-java|org\.seleniumhq\.selenium/.test(t)) add('selenium');
  if (/junit-jupiter|junit-vintage|<artifactId>junit<\/artifactId>|junit:junit|org\.junit/.test(t)) add('junit');
  if (/testng/i.test(t)) add('testng');
  if (/com\.microsoft\.playwright/.test(t)) add('playwright');
  return out;
}

const CONFIG_FILES: Array<[RegExp, FrameworkId]> = [
  [/^playwright\.config\.(ts|js|mjs|cjs|mts|cts)$/, 'playwright'],
  [/^cypress\.config\.(ts|js|mjs|cjs)$/, 'cypress'],
  [/^wdio\.conf(ig)?\.(ts|js|mjs|cjs)$/, 'webdriverio'],
  [/^\.testcaferc\.(json|js)$/, 'testcafe'],
  [/^jest\.config\.(ts|js|mjs|cjs|json)$/, 'jest'],
  [/^vitest\.config\.(ts|js|mjs|cjs|mts)$/, 'vitest'],
  [/^\.mocharc\.(json|js|cjs|yml|yaml|jsonc)$/, 'mocha'],
  [/^pytest\.ini$/, 'pytest'],
  [/^conftest\.py$/, 'pytest'],
  [/^robot\.toml$/, 'robot'],
  [/^testng\.xml$/, 'testng'],
];
const MANIFESTS = /^(package\.json|requirements[\w.-]*\.txt|pyproject\.toml|pom\.xml|build\.gradle(\.kts)?)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'venv', 'env', '__pycache__', 'coverage', 'vendor', 'site-packages', 'bin', 'obj']);

export const LIMITS = { depth: 3, entries: 5000, manifestBytes: 256 * 1024, ms: 3000, manifests: 40 } as const;

/** Scan one registered project folder. Returns facts only; never throws for an unreadable entry. */
export function detectFrameworks(root: string, now: () => number = Date.now): DetectionResult {
  const started = now();
  const evidence = new Map<FrameworkId, Evidence[]>();
  const push = (id: FrameworkId, e: Evidence) => {
    const list = evidence.get(id) ?? [];
    if (!list.some((x) => x.kind === e.kind && x.file === e.file && x.where === e.where)) list.push(e);
    evidence.set(id, list);
  };
  const scanned = { folders: 0, files: 0, manifestsRead: 0, truncated: false };
  let robotFiles = 0;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    if (scanned.files + scanned.folders >= LIMITS.entries || now() - started > LIMITS.ms) {
      scanned.truncated = true;
      break;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    scanned.folders++;
    const where = depth === 0 ? 'project root' : 'subfolder';
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // never follow links
      if (e.isDirectory()) {
        if (depth < LIMITS.depth && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
        continue;
      }
      if (!e.isFile()) continue;
      scanned.files++;
      const name = e.name;
      for (const [re, id] of CONFIG_FILES) if (re.test(name)) push(id, { kind: 'config_file', file: name, where, detail: '' });
      if (/\.robot$/i.test(name)) robotFiles++;
      if (MANIFESTS.test(name) && scanned.manifestsRead < LIMITS.manifests) {
        const full = path.join(dir, name);
        try {
          if (fs.statSync(full).size > LIMITS.manifestBytes) continue;
          const text = fs.readFileSync(full, 'utf8');
          scanned.manifestsRead++;
          const found = name === 'package.json' ? parsePackageJson(text) : /^requirements/.test(name) ? parseRequirements(text) : name === 'pyproject.toml' ? parsePyproject(text) : parsePomOrGradle(text);
          for (const f of found) push(f.id, { kind: 'dependency', file: name, where, detail: f.version });
        } catch {
          /* unreadable manifest: skipped */
        }
      }
    }
  }
  if (robotFiles > 0) push('robot', { kind: 'test_files', file: '*.robot', where: 'subfolder', detail: `${robotFiles} file(s)` });

  const frameworks: DetectedFramework[] = [...evidence.entries()].map(([id, ev]) => ({
    id,
    ...FRAMEWORKS[id],
    confidence: ev.some((x) => x.kind === 'config_file') ? 'config' : ev.some((x) => x.kind === 'dependency') ? 'dependency' : 'files',
    evidence: ev.slice(0, 10),
  }));
  const rank = { config: 0, dependency: 1, files: 2 } as const;
  frameworks.sort((a, b) => rank[a.confidence] - rank[b.confidence] || a.label.localeCompare(b.label));
  const notes: string[] = [];
  if (frameworks.length === 0) notes.push('No known test framework was found in the project root or up to three folders down. Tests in other tools can still be imported as JUnit XML.');
  if (scanned.truncated) notes.push('The scan stopped early (very large folder), so something may have been missed.');
  return { frameworks, scanned, notes };
}
