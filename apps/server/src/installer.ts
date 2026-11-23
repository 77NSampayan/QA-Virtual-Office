/**
 * Safe Claude Code installer for hooks and the (opt-in) status line, user-level settings.json.
 * See docs/security.md.
 *  - honours CLAUDE_CONFIG_DIR; refuses to touch invalid JSON
 *  - timestamped backup before any change; dry-run plan summaries available
 *  - merges ONLY our entries (identified by the absolute script path); idempotent
 *  - atomic write after re-checking mtime (no clobbering concurrent edits)
 *  - uninstall removes only our entries and the keys we created (install manifest), then verifies
 *  - hook handlers are async command hooks that always exit 0 -> cannot block or decide anything
 *  - an existing status line is WRAPPED (its output is preserved) and restored on uninstall
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_EVENTS } from '@qavo/shared';
import { writeFileAtomic, type DataDirPaths } from './dataDir.ts';

export const HOOK_TIMEOUT_SECONDS = 10;
export const FORWARDER_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../forwarder/dist');
const BUILT_FORWARDER = path.join(FORWARDER_DIST, 'forward.mjs');
const BUILT_STATUSLINE = path.join(FORWARDER_DIST, 'statusline.mjs');

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
  statuslineSource?: string;
}

export interface HookHandler {
  type?: string;
  command?: string;
  args?: unknown[];
  [k: string]: unknown;
}
export interface HookGroup {
  matcher?: string;
  hooks?: HookHandler[];
  [k: string]: unknown;
}
interface StatusLineSetting {
  type?: string;
  command?: string;
  padding?: number;
  refreshInterval?: number;
  [k: string]: unknown;
}
export type Settings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]>; statusLine?: StatusLineSetting };

export interface Manifest {
  forwarderPath?: string;
  nodePath?: string;
  permissionHook?: { installedAt: string; createdHooksKey: boolean; createdEventKey: boolean };
  hooks?: { installedAt: string; createdHooksKey: boolean; createdEventKeys: string[] };
  statusLine?: { installedAt: string; hadOriginal: boolean; original?: StatusLineSetting };
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

export const norm = (p: string) => path.resolve(p).toLowerCase();
const fwd = (p: string) => p.replace(/\\/g, '/');

// ---------------------------------------------------------------------------- hooks (plan/merge)
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

export function planUninstall(current: Settings, forwarderPath: string, created: { hooksKey: boolean; eventKeys: string[] } | null): Settings {
  const out = removeOurs(current, forwarderPath);
  if (!out.hooks) return out;
  const createdSet = new Set(created?.eventKeys ?? []);
  for (const [event, groups] of Object.entries(out.hooks)) {
    if (Array.isArray(groups) && groups.length === 0 && (createdSet.has(event) || !created)) delete out.hooks[event];
  }
  if (Object.keys(out.hooks).length === 0 && (created?.hooksKey ?? true)) delete out.hooks;
  return out;
}

// ---------------------------------------------------------------------------- status line (plan/merge)
export function statusLineCommand(nodePath: string, scriptPath: string): string {
  return `"${fwd(nodePath)}" "${fwd(scriptPath)}"`;
}

export function isOurStatusLine(sl: StatusLineSetting | undefined, scriptPath: string): boolean {
  return !!sl && typeof sl.command === 'string' && fwd(sl.command).toLowerCase().includes(fwd(scriptPath).toLowerCase());
}

export function planStatusLineInstall(current: Settings, nodePath: string, scriptPath: string): Settings {
  const out: Settings = structuredClone(current);
  const prev = isOurStatusLine(current.statusLine, scriptPath) ? undefined : current.statusLine;
  const next: StatusLineSetting = { type: 'command', command: statusLineCommand(nodePath, scriptPath) };
  if (prev && typeof prev.padding === 'number') next.padding = prev.padding;
  if (prev && typeof prev.refreshInterval === 'number') next.refreshInterval = prev.refreshInterval;
  if (!prev && current.statusLine && typeof current.statusLine.refreshInterval === 'number') {
    next.refreshInterval = current.statusLine.refreshInterval;
  }
  out.statusLine = next;
  return out;
}

export function planStatusLineUninstall(current: Settings, scriptPath: string, m: Manifest['statusLine'] | undefined): Settings {
  if (!isOurStatusLine(current.statusLine, scriptPath)) return structuredClone(current);
  const out: Settings = structuredClone(current);
  if (m?.hadOriginal && m.original) out.statusLine = structuredClone(m.original);
  else delete out.statusLine;
  return out;
}

// ---------------------------------------------------------------------------- IO helpers
export function readSettings(file: string): { obj: Settings; existed: boolean; mtimeMs: number | null; text: string | null } {
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

export const jsonEq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function backup(paths: DataDirPaths, text: string | null): string | null {
  if (text === null) return null;
  fs.mkdirSync(paths.settingsBackups, { recursive: true });
  const stampStr = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(paths.settingsBackups, `settings.${stampStr}.json`);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

export function writeChecked(file: string, obj: Settings, expectedMtime: number | null) {
  if (expectedMtime !== null && fs.existsSync(file) && fs.statSync(file).mtimeMs !== expectedMtime) {
    throw new Error('settings_changed_concurrently: settings.json changed while installing; nothing was written');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n');
}

export function readManifest(paths: DataDirPaths): Manifest | null {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.installManifest, 'utf8')) as Record<string, unknown>;
    // Pass 1A manifests were flat: {installedAt, forwarderPath, nodePath, createdHooksKey, createdEventKeys}
    if ('createdHooksKey' in raw) {
      return {
        forwarderPath: raw.forwarderPath as string,
        nodePath: raw.nodePath as string,
        hooks: {
          installedAt: raw.installedAt as string,
          createdHooksKey: raw.createdHooksKey as boolean,
          createdEventKeys: (raw.createdEventKeys as string[]) ?? [],
        },
      };
    }
    return raw as Manifest;
  } catch {
    return null;
  }
}

export function writeManifest(paths: DataDirPaths, m: Manifest) {
  if (!m.hooks && !m.statusLine && !m.permissionHook) {
    fs.rmSync(paths.installManifest, { force: true });
    return;
  }
  writeFileAtomic(paths.installManifest, JSON.stringify(m, null, 2));
}

export function copyScript(src: string, dest: string, missing: string) {
  if (!fs.existsSync(src)) throw new Error(`${missing}: run \`npm run build:forwarder\` first`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  writeFileAtomic(dest, fs.readFileSync(src, 'utf8'));
}

export function copyForwarder(ctx: InstallContext): void {
  copyScript(ctx.forwarderSource ?? BUILT_FORWARDER, ctx.paths.forwarder, 'forwarder_not_built');
}
export function copyStatusLineScript(ctx: InstallContext): void {
  copyScript(ctx.statuslineSource ?? BUILT_STATUSLINE, ctx.paths.statuslineScript, 'statusline_not_built');
}

export interface InstallResult {
  changed: boolean;
  settingsPath: string;
  backupPath: string | null;
  verified: boolean;
}

// ---------------------------------------------------------------------------- hooks install/uninstall
export function install(ctx: InstallContext): InstallResult {
  const settingsPath = ctx.settingsPath ?? claudeSettingsPath();
  const nodePath = ctx.nodePath ?? resolveNodePath();
  copyForwarder(ctx);
  const cur = readSettings(settingsPath);
  const next = planInstall(cur.obj, nodePath, ctx.paths.forwarder);
  if (jsonEq(next, cur.obj)) return { changed: false, settingsPath, backupPath: null, verified: verifyInstalled(settingsPath, ctx.paths.forwarder) };

  const m: Manifest = readManifest(ctx.paths) ?? {};
  m.forwarderPath = ctx.paths.forwarder;
  m.nodePath = nodePath;
  m.hooks ??= {
    installedAt: new Date().toISOString(),
    createdHooksKey: !cur.obj.hooks,
    createdEventKeys: HOOK_EVENTS.filter((e) => !(cur.obj.hooks && Array.isArray(cur.obj.hooks[e]))),
  };
  const backupPath = backup(ctx.paths, cur.text);
  writeChecked(settingsPath, next, cur.mtimeMs);
  writeManifest(ctx.paths, m);
  return { changed: true, settingsPath, backupPath, verified: verifyInstalled(settingsPath, ctx.paths.forwarder) };
}

export function uninstall(ctx: InstallContext): InstallResult {
  const settingsPath = ctx.settingsPath ?? claudeSettingsPath();
  const cur = readSettings(settingsPath);
  const m = readManifest(ctx.paths);
  const next = planUninstall(
    cur.obj,
    ctx.paths.forwarder,
    m?.hooks ? { hooksKey: m.hooks.createdHooksKey, eventKeys: m.hooks.createdEventKeys } : null,
  );
  if (jsonEq(next, cur.obj)) return { changed: false, settingsPath, backupPath: null, verified: !verifyAny(settingsPath, ctx.paths.forwarder) };
  const backupPath = backup(ctx.paths, cur.text);
  writeChecked(settingsPath, next, cur.mtimeMs);
  if (m) {
    delete m.hooks;
    writeManifest(ctx.paths, m);
  }
  return { changed: true, settingsPath, backupPath, verified: !verifyAny(settingsPath, ctx.paths.forwarder) };
}

// ---------------------------------------------------------------------------- status line install/uninstall
export function installStatusLine(ctx: InstallContext): InstallResult & { wrapped: boolean } {
  const settingsPath = ctx.settingsPath ?? claudeSettingsPath();
  const nodePath = ctx.nodePath ?? resolveNodePath();
  copyStatusLineScript(ctx);
  const cur = readSettings(settingsPath);
  const script = ctx.paths.statuslineScript;
  const next = planStatusLineInstall(cur.obj, nodePath, script);
  const already = isOurStatusLine(cur.obj.statusLine, script);
  if (jsonEq(next, cur.obj)) return { changed: false, settingsPath, backupPath: null, verified: already, wrapped: false };

  const m: Manifest = readManifest(ctx.paths) ?? {};
  m.nodePath = nodePath;
  const original = already ? m.statusLine?.original : cur.obj.statusLine;
  m.statusLine = {
    installedAt: m.statusLine?.installedAt ?? new Date().toISOString(),
    hadOriginal: !!original,
    ...(original ? { original } : {}),
  };
  const wrapped = !!original && typeof original.command === 'string' && original.command !== '';
  if (wrapped) writeFileAtomic(ctx.paths.statuslineWrap, JSON.stringify({ command: original!.command }));
  else fs.rmSync(ctx.paths.statuslineWrap, { force: true });
  const backupPath = backup(ctx.paths, cur.text);
  writeChecked(settingsPath, next, cur.mtimeMs);
  writeManifest(ctx.paths, m);
  return { changed: true, settingsPath, backupPath, verified: isOurStatusLine(readSettings(settingsPath).obj.statusLine, script), wrapped };
}

export function uninstallStatusLine(ctx: InstallContext): InstallResult {
  const settingsPath = ctx.settingsPath ?? claudeSettingsPath();
  const cur = readSettings(settingsPath);
  const script = ctx.paths.statuslineScript;
  const m = readManifest(ctx.paths);
  const next = planStatusLineUninstall(cur.obj, script, m?.statusLine);
  let backupPath: string | null = null;
  let changed = false;
  if (!jsonEq(next, cur.obj)) {
    backupPath = backup(ctx.paths, cur.text);
    writeChecked(settingsPath, next, cur.mtimeMs);
    changed = true;
  }
  fs.rmSync(ctx.paths.statuslineWrap, { force: true });
  if (m) {
    delete m.statusLine;
    writeManifest(ctx.paths, m);
  }
  return { changed, settingsPath, backupPath, verified: !isOurStatusLine(readSettings(settingsPath).obj.statusLine, script) };
}

// ---------------------------------------------------------------------------- status + plan summaries
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

const sameFile = (a: string, b: string) => {
  try {
    return fs.readFileSync(a, 'utf8') === fs.readFileSync(b, 'utf8');
  } catch {
    return false;
  }
};

/** Status for the API: booleans/enums only (no filesystem paths in API responses). */
export function hookStatus(ctx: { paths: DataDirPaths; settingsPath?: string }) {
  const settingsPath = ctx.settingsPath ?? claudeSettingsPath();
  const events = eventsWithOurs(settingsPath, ctx.paths.forwarder);
  const count = Object.values(events).filter(Boolean).length;
  let statusLine: 'installed' | 'not_installed' | 'other_configured' = 'not_installed';
  try {
    const sl = readSettings(settingsPath).obj.statusLine;
    statusLine = isOurStatusLine(sl, ctx.paths.statuslineScript) ? 'installed' : sl ? 'other_configured' : 'not_installed';
  } catch {
    /* invalid settings */
  }
  return {
    state: count === HOOK_EVENTS.length ? 'installed' : count === 0 ? 'not_installed' : 'partial',
    events,
    forwarderPresent: fs.existsSync(ctx.paths.forwarder),
    forwarderUpToDate: sameFile(ctx.paths.forwarder, BUILT_FORWARDER),
    statusLine,
    statusLineUpToDate: sameFile(ctx.paths.statuslineScript, BUILT_STATUSLINE),
  };
}

export interface PlanSummary {
  kind: 'hooks' | 'statusLine';
  action: 'install' | 'uninstall';
  settingsFile: string;
  noChange: boolean;
  willCreateBackup: boolean;
  eventsAdded: string[];
  eventsRemoved: string[];
  wrapsExistingStatusLine: boolean;
  restoresOriginalStatusLine: boolean;
  /** Path-free description of what will be written. */
  handler: Record<string, unknown> | null;
  warning: string | null;
}

/** Dry-run summary for the UI. Never contains filesystem paths. */
export function describePlan(kind: PlanSummary['kind'], action: PlanSummary['action'], ctx: InstallContext): PlanSummary {
  const settingsPath = ctx.settingsPath ?? claudeSettingsPath();
  const cur = readSettings(settingsPath);
  const nodePath = ctx.nodePath ?? resolveNodePath();
  const m = readManifest(ctx.paths);
  let next: Settings;
  if (kind === 'hooks') {
    next = action === 'install'
      ? planInstall(cur.obj, nodePath, ctx.paths.forwarder)
      : planUninstall(cur.obj, ctx.paths.forwarder, m?.hooks ? { hooksKey: m.hooks.createdHooksKey, eventKeys: m.hooks.createdEventKeys } : null);
  } else {
    next = action === 'install'
      ? planStatusLineInstall(cur.obj, nodePath, ctx.paths.statuslineScript)
      : planStatusLineUninstall(cur.obj, ctx.paths.statuslineScript, m?.statusLine);
  }
  const had = eventsWithOurs(settingsPath, ctx.paths.forwarder);
  const eventsAdded: string[] = [];
  const eventsRemoved: string[] = [];
  if (kind === 'hooks') {
    for (const e of HOOK_EVENTS) {
      if (action === 'install' && !had[e]) eventsAdded.push(e);
      if (action === 'uninstall' && had[e]) eventsRemoved.push(e);
    }
  }
  const sl = cur.obj.statusLine;
  const ours = isOurStatusLine(sl, ctx.paths.statuslineScript);
  return {
    kind,
    action,
    settingsFile: 'settings.json',
    noChange: jsonEq(next, cur.obj),
    willCreateBackup: !jsonEq(next, cur.obj) && cur.existed,
    eventsAdded,
    eventsRemoved,
    wrapsExistingStatusLine: kind === 'statusLine' && action === 'install' && !!sl && !ours,
    restoresOriginalStatusLine: kind === 'statusLine' && action === 'uninstall' && ours && !!m?.statusLine?.hadOriginal,
    handler:
      action === 'install'
        ? kind === 'hooks'
          ? { type: 'command', command: '<node.exe>', args: ['<data dir>/hooks/forward.mjs'], async: true, timeout: HOOK_TIMEOUT_SECONDS }
          : { type: 'command', command: '"<node.exe>" "<data dir>/hooks/statusline.mjs"' }
        : null,
    warning: kind === 'hooks' && action === 'install' ? CROSS_PROJECT_WARNING : null,
  };
}
