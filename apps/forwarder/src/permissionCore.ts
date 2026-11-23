/**
 * Permission hook core (V4b): a SYNCHRONOUS Claude Code hook on PermissionRequest.
 *
 * The contract, in order of importance:
 *  1. It NEVER approves or denies on its own. It prints a decision ONLY after a person has decided in the office
 *     (the server returns "allowed" or "denied"). Every other outcome prints NOTHING and exits 0, which leaves Claude
 *     Code's normal permission prompt exactly as it would have been (documented: staying silent does not approve).
 *  2. It does nothing at all unless the person turned the bridge on, and only for REGISTERED projects.
 *  3. It never throws, never exits non-zero (exit 2 is not honoured for this event, and any other failure could block),
 *     and gives up well before Claude Code's own timeout.
 *  4. What it sends is the tool name, the project id, and (only if the person turned on tool-input capture) a short
 *     redacted, path-masked summary: never the raw tool input, never file contents, never the cwd.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parsePolicy, type CapturePolicy } from '@qavo/shared/policy';
import { parseFolderKeySecret } from '@qavo/shared/folderKeys';
import { resolveProject } from '@qavo/shared/resolve';
import { safeToolName, summarizeToolInput } from '@qavo/shared/permissionSummary';
import { appendCappedLog } from './core.ts';

export const REQUEST_TIMEOUT_MS = 2000;
export const POLL_MS = 20_000;
export const MAX_WAIT_SECONDS = 115; // always below the 130 s timeout the installer gives the hook

export type PermissionOutcome =
  | 'allowed'
  | 'denied'
  | 'no_answer'
  | 'ignored:not_a_permission_request'
  | 'ignored:bridge_off'
  | 'ignored:unregistered'
  | 'ignored:no_token'
  | 'ignored:invalid_payload'
  | 'failed:server_unreachable'
  | 'failed:server_refused';

export interface PermissionDeps {
  dataDir: string;
  stdinText: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** The documented Claude Code reply for a person's decision. `allow` carries no updated input or rules: it allows this one request. */
export function decisionJson(kind: 'allow' | 'deny'): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: kind === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied from QA Virtual Office', interrupt: false },
    },
  });
}

const readText = (p: string): string | null => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

function log(dataDir: string, tool: string, outcome: PermissionOutcome) {
  appendCappedLog(path.join(dataDir, 'logs', 'permission-hook.log'), JSON.stringify({ ts: new Date().toISOString(), tool, outcome }));
}

function rootsOf(policy: CapturePolicy, projectId: string): string[] {
  const p = policy.projects.find((x) => x.id === projectId);
  return p ? [p.lexical, ...(p.canonical ? [p.canonical] : [])] : [];
}

export async function runPermissionHook(deps: PermissionDeps): Promise<{ stdout: string; outcome: PermissionOutcome }> {
  const { dataDir } = deps;
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const silent = (outcome: PermissionOutcome, tool = '-') => {
    log(dataDir, tool, outcome);
    return { stdout: '', outcome };
  };

  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(deps.stdinText) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return silent('ignored:invalid_payload');
    raw = parsed as Record<string, unknown>;
  } catch {
    return silent('ignored:invalid_payload');
  }
  if (raw.hook_event_name !== 'PermissionRequest') return silent('ignored:not_a_permission_request');
  const toolName = safeToolName(raw.tool_name);
  const sessionId = typeof raw.session_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(raw.session_id) ? raw.session_id : null;
  if (!sessionId) return silent('ignored:invalid_payload', toolName);

  const { policy, failClosed } = parsePolicy(readText(path.join(dataDir, 'capture-policy.json')));
  if (failClosed || !policy.permissionBridge.enabled) return silent('ignored:bridge_off', toolName);
  const resolution = resolveProject(raw.cwd, policy, () => parseFolderKeySecret(readText(path.join(dataDir, 'folder-key.secret'))));
  if (resolution.kind !== 'project') return silent('ignored:unregistered', toolName); // only registered projects, never unregistered folders
  const token = readText(path.join(dataDir, 'token'))?.trim();
  if (!token) return silent('ignored:no_token', toolName);

  const base = `http://127.0.0.1:${policy.collector.port}/api/permission-hook`;
  // 'connection: close' so no keep-alive socket is left open when the process ends (a lingering socket can crash a Windows exit)
  const headers = { 'content-type': 'application/json', 'x-qavo-token': token, connection: 'close' };
  const summary = policy.capture.toolInputs ? summarizeToolInput(toolName, raw.tool_input, rootsOf(policy, resolution.projectId)) : null;

  let id: string;
  try {
    const res = await doFetch(`${base}/request`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sessionId, projectId: resolution.projectId, toolName, summary }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return silent('failed:server_refused', toolName);
    const body = (await res.json()) as { id?: unknown };
    if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(body.id)) return silent('failed:server_refused', toolName);
    id = body.id;
  } catch {
    return silent('failed:server_unreachable', toolName);
  }

  const deadline = now() + Math.min(policy.permissionBridge.waitSeconds, MAX_WAIT_SECONDS) * 1000;
  while (now() < deadline) {
    let status = '';
    const wait = Math.max(0, Math.min(POLL_MS, deadline - now())); // the last poll never runs past the deadline
    try {
      const res = await doFetch(`${base}/wait/${id}?wait=${wait}`, { headers: { 'x-qavo-token': token, connection: 'close' }, signal: AbortSignal.timeout(wait + 5000) });
      if (!res.ok) return silent('failed:server_refused', toolName);
      status = String(((await res.json()) as { status?: unknown }).status ?? '');
    } catch {
      return silent('failed:server_unreachable', toolName);
    }
    if (status === 'allowed') {
      log(dataDir, toolName, 'allowed');
      return { stdout: decisionJson('allow'), outcome: 'allowed' };
    }
    if (status === 'denied') {
      log(dataDir, toolName, 'denied');
      return { stdout: decisionJson('deny'), outcome: 'denied' };
    }
    if (status !== 'pending') return silent('no_answer', toolName); // expired, answered elsewhere, or unknown: say nothing
  }
  return silent('no_answer', toolName);
}
