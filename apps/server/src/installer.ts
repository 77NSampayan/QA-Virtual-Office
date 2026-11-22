/**
 * Safe Claude Code hook installer (user-level settings.json). See docs/security.md.
 *  - honours CLAUDE_CONFIG_DIR; refuses to touch invalid JSON
 *  - timestamped backup before any change; dry-run plan available
 *  - merges ONLY our handlers (identified by the absolute forwarder path); idempotent
 *  - atomic write after re-checking mtime (no clobbering concurrent edits)
 *  - uninstall removes only our handlers and the keys we created (install manifest), then verifies
 *  - handlers are async command hooks that always exit 0 -> cannot block or decide anything
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_EVENTS } from '@qavo/shared';
import { writeFileAtomic, type DataDirPaths } from './dataDir.ts';

export const HOOK_TIMEOUT_SECONDS = 10;
const BUILT_FORWARDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../forwarder/dist/forward.mjs');

export const CROSS_PROJECT_WARNING = [
  'IMPORTANT: these hooks are installed at USER level (~/.claude/settings.json).',
  'They run for Claude Code sessions in EVERY folder on this PC, not just your QA projects.',
  'With the default "Registered projects only" scope, the forwarder drops events from',
  'unregistered folders locally, before anything is sent. Only metadata is collected',
  '(no prompts, tool inputs/outputs, file contents, transcripts or paths).',
  'Hooks run asynchronously, always exit 0, and cannot approve, deny or block anything.',
].join('\n');

export interface InstallContext {
  paths: DataDirPaths;
  settingsPath?: string;
  nodePath?: string;
  forwarderSource?: string;
}

interface HookHandler {
  type?: string;
  command?: string;
  args?: unknown[];
  [k: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookHandler[];
  [k: string]: unknown;
}
type Settings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> };

interface InstallManifest {
  installedAt: string;
  forwarderPath: string;
  nodePath: string;
  createdHooksKey: boolean;
  createdEventKeys: string[];
}

export function claudeSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(dir, 'settings.json');
}

export function resolveNodePath(): string {
  if (process.platform === 'win32') {
    try {
      const where = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe');
      const first = execFileSync(where, ['node'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0]?.trim();
      if (first && /node\.exe$/i.test(first)) return first;
    } catch {
      /* fall through */
    }
  }
  if (/node(\.exe)?$/i.test(process.execPath)) return process.execPath;
  throw new Error('node_not_found: Node.js is required to run the hook forwarder');
}

const norm = (p: string) => path.resolve(p).toLowerCase();

export function isOurHandler(h: HookHandler, forwarderPath: string): boolean {
  const target = norm(forwarderPath);
  if (Array.isArray(h.args) && h.args.some((a) => typeof a === 'string' && norm(a) === target)) return true;
  if (typeof h.command === 'string') {
    const c = h.command.replace(/\//g, '\\').toLowerCase();
    if (c.includes(target)) return true;
  }
  return false;
}

export function ourHandler(nodePath: string, forwarderPath: string): HookHandler {
  return { type: 'command', command: nodePath, args: [forwarderPath], async: true, timeout: HOOK_TIMEOUT_SECONDS };
}

function readSettings(file: string): { obj: Settings; existed: boolean; mtimeMs: number | null; text: string | null } {
  if (!fs.existsSync(file)) return { obj: {}, existed: false, mtimeMs: null, text: null };
  const text = fs.readFileSync(file, 'utf8');
  let obj: unknown;
  try {
    obj = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    throw new Error('settings_invalid_json: refusing to modify a settings.json that is not valid JSON');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('settings_invalid_shape');
  return { obj: obj as Settings, existed: true, mtimeMs: fs.statSync(file).mtimeMs, text };
}

function removeOurs(obj: Settings, forwarderPath: string): Settings {
  const out: Settings = structuredClone(obj);
  if (!out.hooks || typeof out.hooks !== 'object') return out;
  for (const [event, groups] of Object.entries(out.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept: HookGroup[] = [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) {
        kept.push(g);
        continue;
      }
      const hadOurs = g.hooks.some((h) => isOurHandler(h, forwarderPath));
      const hooks = g.hooks.filter((h) => !isOurHandler(h, forwarderPath));
      if (hooks.length > 0 || !hadOurs) kept.push({ ...g, hooks });
    }
    out.hooks[event] = kept;
  }
  return out;
}

export function planInstall(current: Settings, nodePath: string, forwarderPath: string): Settings {
  const out = removeOurs(current, forwarderPath);
  if (!out.hooks || typeof out.hooks !== 'object') out.hooks = {};
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(out.hooks[event]) ? out.hooks[event]! : [];
    groups.push({ hooks: [ourHandler(nodePath, forwarderPath)] });
    out.hooks[event] = groups;
  }
  return out;
}

export function planUninstall(current: Settings, forwarderPath: string, manifest: InstallManifest | null): Settings {
  const out = removeOurs(current, forwarderPath);
  if (!out.hooks) return out;
  const created = new Set(manifest?.createdEventKeys ?? []);
  for (const [event, groups] of Object.entries(out.hooks)) {
    if (Array.isArray(groups) && groups.length === 0 && (created.has(event) || !manifest)) delete out.hooks[event];
  }
  if (Object.keys(out.hooks).length === 0 && (manifest?.createdHooksKey ?? true)) delete out.hooks;
  return out;
}

const jsonEq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function backup(paths: DataDirPaths, settingsFile: string, text: string | null): string | null {
  if (text === null) return null;
  fs.mkdirSync(paths.settingsBackups, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(paths.settingsBackups, `settings.${stamp}.json`);
  fs.writeFileSync(file, text, 'utf8');
  void settingsFile;
  return file;
}

function writeChecked(file: string, obj: Settings, expectedMtime: number | null) {
  if (expectedMtime !== null && fs.existsSync(file) && fs.statSync(file).mtimeMs !== expectedMtime) {
    throw new Error('settings_changed_concurrently: settings.json changed while installing; nothing was written');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n');
}

export interface InstallResult {
  changed: boolean;
  settingsPath: string;
  backupPath: string | null;
  verified: boolean;
}

export function copyForwarder(ctx: InstallContext): void {
  const src = ctx.forwarderSource ?? BUILT_FORWARDER;
  if (!fs.existsSync(src)) throw new Error('forwarder_not_built: run `npm run build:forwarder` first');
  fs.mkdirSync(ctx.paths.hooksDir, { recursive: true });
  writeFileAtomic(ctx.paths.forwarder, fs.readFileSync(src, 'utf8'));
}

export function install(ctx: InstallContext): InstallResult {
  const settingsPath = ctx.settingsPath ?? claudeSettingsPath();
  const nodePath = ctx.nodePath ?? resolveNodePath();
  copyForwarder(ctx);
  const cur = readSettings(settingsPath);
  const next = planInstall(cur.obj, nodePath, ctx.paths.forwarder);
  if (jsonEq(next, cur.obj)) return { changed: false, settingsPath, backupPath: null, verified: verifyInstalled(settingsPath, ctx.paths.forwarder) };

  const prevManifest = readManifest(ctx.paths);
  const manifest: InstallManifest = prevManifest ?? {
    installedAt: new Date().toISOString(),
    forwarderPath: ctx.paths.forwarder,
    nodePath,
    createdHooksKey: !cur.obj.hooks,
    createdEventKeys: HOOK_EVENTS.filter((e) => !(cur.obj.hooks && Array.isArray(cur.obj.hooks[e]))),
  };
  const backupPath = backup(ctx.paths, settingsPath, cur.text);
  writeChecked(settingsPath, next, cur.mtimeMs);
  writeFileAtomic(ctx.paths.installManifest, JSON.stringify(manifest, null, 2));
  return { changed: true, settingsPath, backupPath, verified: verifyInstalled(settingsPath, ctx.paths.forwarder) };
}

export function uninstall(ctx: InstallContext): InstallResult {
  const settingsPath = ctx.settingsPath ?? claudeSettingsPath();
  const cur = readSettings(settingsPath);
  const manifest = readManifest(ctx.paths);
  const next = planUninstall(cur.obj, ctx.paths.forwarder, manifest);
  if (jsonEq(next, cur.obj)) return { changed: false, settingsPath, backupPath: null, verified: !verifyAny(settingsPath, ctx.paths.forwarder) };
  const backupPath = backup(ctx.paths, settingsPath, cur.text);
  writeChecked(settingsPath, next, cur.mtimeMs);
  try {
    fs.unlinkSync(ctx.paths.installManifest);
  } catch {
    /* ignore */
  }
  return { changed: true, settingsPath, backupPath, verified: !verifyAny(settingsPath, ctx.paths.forwarder) };
}

function readManifest(paths: DataDirPaths): InstallManifest | null {
  try {
    return JSON.parse(fs.readFileSync(paths.installManifest, 'utf8')) as InstallManifest;
  } catch {
    return null;
  }
}

function eventsWithOurs(settingsPath: string, forwarderPath: string): Record<string, boolean> {
  let obj: Settings = {};
  try {
    obj = readSettings(settingsPath).obj;
  } catch {
    /* invalid settings: report none */
  }
  const out: Record<string, boolean> = {};
  for (const e of HOOK_EVENTS) {
    const groups = obj.hooks?.[e];
    out[e] = Array.isArray(groups) && groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => isOurHandler(h, forwarderPath)));
  }
  return out;
}

function verifyInstalled(settingsPath: string, forwarderPath: string): boolean {
  return Object.values(eventsWithOurs(settingsPath, forwarderPath)).every(Boolean);
}
function verifyAny(settingsPath: string, forwarderPath: string): boolean {
  return Object.values(eventsWithOurs(settingsPath, forwarderPath)).some(Boolean);
}

/** Status for the API: booleans only (no filesystem paths in API responses). */
export function hookStatus(ctx: { paths: DataDirPaths; settingsPath?: string }) {
  const settingsPath = ctx.settingsPath ?? claudeSettingsPath();
  const events = eventsWithOurs(settingsPath, ctx.paths.forwarder);
  const count = Object.values(events).filter(Boolean).length;
  let forwarderUpToDate = false;
  try {
    forwarderUpToDate = fs.readFileSync(ctx.paths.forwarder, 'utf8') === fs.readFileSync(BUILT_FORWARDER, 'utf8');
  } catch {
    /* missing */
  }
  return {
    state: count === HOOK_EVENTS.length ? 'installed' : count === 0 ? 'not_installed' : 'partial',
    events,
    forwarderPresent: fs.existsSync(ctx.paths.forwarder),
    forwarderUpToDate,
  };
}
