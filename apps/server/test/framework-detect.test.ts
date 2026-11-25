import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type DB } from '../src/db/index.ts';
import { detectFrameworks, parsePackageJson, parsePomOrGradle, parsePyproject, parseRequirements } from '../src/frameworkDetect.ts';
import * as au from '../src/qaAutomation.ts';
import { createProject, HttpError } from '../src/store.ts';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qavo-detect-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const put = (rel: string, text = '') => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

describe('manifest readers', () => {
  it('package.json: dependency names and declared versions only', () => {
    const r = parsePackageJson(JSON.stringify({ name: 'x', scripts: { test: 'secret-command --token abc' }, devDependencies: { '@playwright/test': '^1.48.0', jest: '29.7.0', left: '1' } }));
    expect(r).toEqual([
      { id: 'playwright', version: '^1.48.0' },
      { id: 'jest', version: '29.7.0' },
    ]);
    expect(parsePackageJson('not json')).toEqual([]);
  });
  it('requirements: pytest, robot, selenium, extras and comments', () => {
    const r = parseRequirements('# comment\npytest==8.1.0\npytest-xdist>=3  # fast\nrobotframework>=7.0\nselenium[chrome]~=4.20\nrequests==2.0\n--index-url https://user:pw@example.com\n');
    expect(r).toEqual([
      { id: 'pytest', version: '==8.1.0' },
      { id: 'robot', version: '>=7.0' },
      { id: 'selenium', version: '~=4.20' },
    ]);
    expect(JSON.stringify(r)).not.toMatch(/user:pw/);
  });
  it('pyproject, pom and gradle', () => {
    expect(parsePyproject('[tool.pytest.ini_options]\naddopts = "-q"\n[project]\ndependencies = ["selenium>=4"]').map((x) => x.id).sort()).toEqual(['pytest', 'selenium']);
    expect(parsePomOrGradle('<artifactId>selenium-java</artifactId><artifactId>junit-jupiter</artifactId><artifactId>testng</artifactId>').map((x) => x.id).sort()).toEqual(['junit', 'selenium', 'testng']);
    expect(parsePomOrGradle("testImplementation 'org.junit.jupiter:junit-jupiter:5.10.0'").map((x) => x.id)).toEqual(['junit']);
  });
});

describe('detectFrameworks', () => {
  it('finds config files and dependencies, reports base names and where, never paths or contents', () => {
    put('playwright.config.ts', 'export default { secret: "do-not-read-me" }');
    put('package.json', JSON.stringify({ devDependencies: { '@playwright/test': '^1.48.0', mocha: '^10' } }));
    put('api/requirements.txt', 'pytest==8.1.0\n');
    put('api/tests/conftest.py', 'API_KEY = "do-not-read-me"');
    put('ui/login.robot', '*** Test Cases ***\n');
    put('ui/cart.robot', '');
    const r = detectFrameworks(root);
    const by = Object.fromEntries(r.frameworks.map((f) => [f.id, f]));
    expect(Object.keys(by).sort()).toEqual(['mocha', 'playwright', 'pytest', 'robot']);
    expect(by.playwright).toMatchObject({ confidence: 'config' });
    expect(by.playwright!.evidence.map((e) => e.file).sort()).toEqual(['package.json', 'playwright.config.ts']);
    expect(by.playwright!.evidence.find((e) => e.file === 'package.json')).toMatchObject({ detail: '^1.48.0', where: 'project root' });
    expect(by.pytest!.evidence.map((e) => `${e.file}:${e.where}`).sort()).toEqual(['conftest.py:subfolder', 'requirements.txt:subfolder']);
    expect(by.robot).toMatchObject({ confidence: 'files' });
    expect(by.robot!.evidence[0]!.detail).toBe('2 file(s)');
    expect(by.mocha).toMatchObject({ confidence: 'dependency' });
    const all = JSON.stringify(r);
    expect(all).not.toContain('do-not-read-me');
    expect(all).not.toContain(root.replace(/\\/g, '\\\\'));
    expect(all).not.toMatch(/api\/|ui\/|[A-Za-z]:\\\\/); // no folder paths
    expect(r.scanned.manifestsRead).toBe(2);
  });

  it('does not enter node_modules, virtualenvs, hidden folders or deep trees, and does not read source files', () => {
    put('node_modules/jest/package.json', JSON.stringify({ dependencies: { cypress: '1' } }));
    put('.venv/requirements.txt', 'robotframework\n');
    put('.hidden/playwright.config.ts');
    put('a/b/c/d/jest.config.js');
    put('src/app.test.ts', 'import {test} from "@playwright/test"');
    expect(detectFrameworks(root).frameworks).toEqual([]);
    expect(detectFrameworks(root).notes[0]).toMatch(/No known test framework/);
  });

  it('does not follow links out of the project', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'qavo-outside-'));
    fs.writeFileSync(path.join(outside, 'playwright.config.ts'), '');
    try {
      fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
    } catch {
      fs.rmSync(outside, { recursive: true, force: true });
      return; // no link privilege on this account
    }
    try {
      expect(detectFrameworks(root).frameworks).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('ignores a manifest that is too large, and stops early on a huge folder', () => {
    put('package.json', JSON.stringify({ devDependencies: { jest: '1' }, pad: 'x'.repeat(300 * 1024) }));
    expect(detectFrameworks(root).frameworks).toEqual([]);
    for (let i = 0; i < 40; i++) put(`d${i}/package.json`, JSON.stringify({ devDependencies: { vitest: '1' } }));
    expect(detectFrameworks(root).scanned.manifestsRead).toBeLessThanOrEqual(40);
    let t = 0;
    const slow = detectFrameworks(root, () => (t += 1000));
    expect(slow.scanned.truncated).toBe(true);
  });
});

describe('detect service', () => {
  it('only a person can scan; the project folder must exist', () => {
    const db: DB = openDb(path.join(root, 'test.db'));
    const dir = path.join(root, 'Proj');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'pytest.ini'), '');
    const pid = createProject(db, { alias: 'P', path: dir }).project.id;
    for (const actor of ['agent', 'system'] as const) {
      try {
        au.detectProjectFrameworks(db, pid, actor);
        throw new Error('should have been refused');
      } catch (e) {
        expect(e).toBeInstanceOf(HttpError);
        expect((e as HttpError).status).toBe(403);
      }
    }
    expect(au.detectProjectFrameworks(db, pid, 'human').frameworks.map((f) => f.id)).toEqual(['pytest']);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(() => au.detectProjectFrameworks(db, pid, 'human')).toThrow(/cannot be found/);
    db.close();
  });
});
