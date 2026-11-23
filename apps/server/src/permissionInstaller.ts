/**
 * Install / uninstall of the OPTIONAL permission hook (V4b), same safety rules as the other installers:
 * honours CLAUDE_CONFIG_DIR, refuses invalid JSON, timestamped backup, atomic write after an mtime re-check,
 * merges ONLY our entry (identified by the absolute script path), idempotent, uninstall restores what was there.
 *
 * Unlike the status hooks (async, can never decide anything), this one is SYNCHRONOUS and only on the
 * PermissionRequest event: Claude Code waits for it. The script itself only ever answers when a person has
 * decided in the office; in every other case (app closed, no answer, error) it prints nothing and exits 0, which
 * leaves Claude Code's normal permission prompt exactly as it would have been.
 */
import fs from 'node:fs';
import type { DataDirPaths } from './dataDir.ts';
import {
  backup,
  claudeSettingsPath,
  copyScript,
  FORWARDER_DIST,
  jsonEq,
  norm,
  readManifest,
  readSettings,
  resolveNodePath,
  writeChecked,
  writeManifest,
  type HookGroup,
  type HookHandler,
  type InstallContext,
  type InstallResult,
  type Settings,
} from './installer.ts';
import path from 'node:path';

export const PERMISSION_EVENT = 'PermissionRequest';
/** Claude Code's limit for this hook; the script gives up on its own (policy waitSeconds, 110 s) well before it. */
export const PERMISSION_HOOK_TIMEOUT_SECONDS = 130;
export const BUILT_PERMISSION_HOOK = path.join(FORWARDER_DIST, 'permission.mjs');

export const PERMISSION_WARNING = [
  'This adds ONE synchronous hook, on the PermissionRequest event only (user level, every folder).',
  'While it waits for your answer (up to about 110 seconds) Claude Code pauses at that permission request.',
  'It never approves anything by itself: if the app is closed, the project is not registered, the bridge is off,',
  'or you do not answer in time, it says nothing and Claude Code asks you in the terminal as usual.',
  'Details of a request are shown (redacted) only if you turned on tool-input capture; without them you can deny',
  'or answer in the terminal, but not approve.',
].join('\n');

export function permissionHandler(nodePath: string, scriptPath: string): HookHandler {
  return { type: 'command', command: nodePath, args: [scriptPath], async: false, timeout: PERMISSION_HOOK_TIMEOUT_SECONDS };
}

export function isOurPermissionHandler(h: HookHandler, scriptPath: string): boolean {
  const target = norm(scriptPath);
  if (Array.isArray(h.args) && h.args.some((a) => typeof a === 'string' && norm(a) === target)) return true;
  return typeof h.command === 'string' && h.command.replace(/\//g, '\\').toLowerCase().includes(target);
}

function removeOurs(obj: Settings, scriptPath: string): Settings {
  const out: Settings = structuredClone(obj);
  const groups = out.hooks?.[PERMISSION_EVENT];
  if (!out.hooks || !Array.isArray(groups)) return out;
  const kept: HookGroup[] = [];
  for (const g of groups) {
    if (!g || !Array.isArray(g.hooks)) {
      kept.push(g);
      continue;
    }
    const hadOurs = g.hooks.some((h) => isOurPermissionHandler(h, scriptPath));
    const hooks = g.hooks.filter((h) => !isOurPermissionHandler(h, scriptPath));
    if (hooks.length > 0 || !hadOurs) kept.push({ ...g, hooks });
  }
  out.hooks[PERMISSION_EVENT] = kept;
  return out;
}

export function planPermissionInstall(current: Settings, nodePath: string, scriptPath: string): Settings {
  const out = removeOurs(current, scriptPath);
  if (!out.hooks || typeof out.hooks !== 'object') out.hooks = {};
  const groups = Array.isArray(out.hooks[PERMISSION_EVENT]) ? out.hooks[PERMISSION_EVENT]! : [];
  groups.push({ hooks: [permissionHandler(nodePath, scriptPath)] });
  out.hooks[PERMISSION_EVENT] = groups;
  return out;
}

export function planPermissionUninstall(current: Settings, scriptPath: string, created: { hooksKey: boolean; eventKey: boolean } | null): Settings {
  const out = removeOurs(current, scriptPath);
  if (!out.hooks) return out;
  const groups = out.hooks[PERMISSION_EVENT];
  if (Array.isArray(groups) && groups.length === 0 && (created?.eventKey ?? true)) delete out.hooks[PERMISSION_EVENT];
  if (Object.keys(out.hooks).length === 0 && (created?.hooksKey ?? true)) delete out.hooks;
  return out;
}

export function hasPermissionHook(settingsPath: string, scriptPath: string): boolean {
  try {
    const groups = readSettings(settingsPath).obj.hooks?.[PERMISSION_EVENT];
    return Array.isArray(groups) && groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => isOurPermissionHandler(h, scriptPath)));
  } catch {
    return false;
  }
}

export function installPermissionHook(ctx: InstallContext & { permissionSource?: string }): InstallResult {
  const settingsPath = ctx.settingsPath ?? claudeSettingsPath();
  const nodePath = ctx.nodePath ?? resolveNodePath();
  copyScript(ctx.permissionSource ?? BUILT_PERMISSION_HOOK, ctx.paths.permissionHook, 'permission_hook_not_built');
  const cur = readSettings(settingsPath);
  const next = planPermissionInstall(cur.obj, nodePath, ctx.paths.permissionHook);
  if (jsonEq(next, cur.obj)) return { changed: false, settingsPath, backupPath: null, verified: hasPermissionHook(settingsPath, ctx.paths.permissionHook) };
  const m = readManifest(ctx.paths) ?? {};
  m.nodePath = m.nodePath ?? nodePath;
  m.permissionHook ??= {
    installedAt: new Date().toISOString(),
    createdHooksKey: !cur.obj.hooks,
    createdEventKey: !(cur.obj.hooks && Array.isArray(cur.obj.hooks[PERMISSION_EVENT])),
  };
  const backupPath = backup(ctx.paths, cur.text);
  writeChecked(settingsPath, next, cur.mtimeMs);
  writeManifest(ctx.paths, m);
  return { changed: true, settingsPath, backupPath, verified: hasPermissionHook(settingsPath, ctx.paths.permissionHook) };
}

export function uninstallPermissionHook(ctx: InstallContext): InstallResult {
  const settingsPath = ctx.settingsPath ?? claudeSettingsPath();
  const cur = readSettings(settingsPath);
  const m = readManifest(ctx.paths);
  const next = planPermissionUninstall(cur.obj, ctx.paths.permissionHook, m?.permissionHook ? { hooksKey: m.permissionHook.createdHooksKey, eventKey: m.permissionHook.createdEventKey } : null);
  if (jsonEq(next, cur.obj)) return { changed: false, settingsPath, backupPath: null, verified: !hasPermissionHook(settingsPath, ctx.paths.permissionHook) };
  const backupPath = backup(ctx.paths, cur.text);
  writeChecked(settingsPath, next, cur.mtimeMs);
  if (m) {
    delete m.permissionHook;
    writeManifest(ctx.paths, m);
  }
  fs.rmSync(ctx.paths.permissionHook, { force: true });
  return { changed: true, settingsPath, backupPath, verified: !hasPermissionHook(settingsPath, ctx.paths.permissionHook) };
}

/** Booleans and enums only (no paths): used by the integration status API. */
export function permissionHookStatus(ctx: { paths: DataDirPaths; settingsPath?: string }) {
  const settingsPath = ctx.settingsPath ?? claudeSettingsPath();
  const installed = hasPermissionHook(settingsPath, ctx.paths.permissionHook);
  let upToDate = false;
  try {
    upToDate = fs.readFileSync(ctx.paths.permissionHook, 'utf8') === fs.readFileSync(BUILT_PERMISSION_HOOK, 'utf8');
  } catch {
    /* not built or not installed */
  }
  return { state: installed ? ('installed' as const) : ('not_installed' as const), scriptPresent: fs.existsSync(ctx.paths.permissionHook), upToDate };
}

/** Dry-run summary for the UI (never contains filesystem paths). */
export function describePermissionPlan(action: 'install' | 'uninstall', ctx: InstallContext) {
  const settingsPath = ctx.settingsPath ?? claudeSettingsPath();
  const cur = readSettings(settingsPath);
  const nodePath = ctx.nodePath ?? resolveNodePath();
  const m = readManifest(ctx.paths);
  const next =
    action === 'install'
      ? planPermissionInstall(cur.obj, nodePath, ctx.paths.permissionHook)
      : planPermissionUninstall(cur.obj, ctx.paths.permissionHook, m?.permissionHook ? { hooksKey: m.permissionHook.createdHooksKey, eventKey: m.permissionHook.createdEventKey } : null);
  const had = hasPermissionHook(settingsPath, ctx.paths.permissionHook);
  return {
    kind: 'permission' as const,
    action,
    settingsFile: 'settings.json',
    noChange: jsonEq(next, cur.obj),
    willCreateBackup: !jsonEq(next, cur.obj) && cur.existed,
    eventsAdded: action === 'install' && !had ? [PERMISSION_EVENT] : [],
    eventsRemoved: action === 'uninstall' && had ? [PERMISSION_EVENT] : [],
    handler: action === 'install' ? { type: 'command', command: '<node.exe>', args: ['<data dir>/hooks/permission.mjs'], async: false, timeout: PERMISSION_HOOK_TIMEOUT_SECONDS } : null,
    warning: action === 'install' ? PERMISSION_WARNING : null,
  };
}
