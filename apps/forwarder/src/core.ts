/**
 * Forwarder core: raw hook stdin -> local project resolution -> metadata-only sanitize -> POST.
 * Never throws, never writes raw payload content anywhere. Logs contain only decisions,
 * event names, and short session-id prefixes (plus key NAMES in debug-keys mode).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parsePolicy } from '@qavo/shared/policy';
import { parseFolderKeySecret } from '@qavo/shared/folderKeys';
import { resolveProject } from '@qavo/shared/resolve';
import { sanitizeHookPayload } from '@qavo/shared/sanitize';

export const FORWARDER_VERSION = 1;
export const POST_TIMEOUT_MS = 1500;
const LOG_CAP_BYTES = 512 * 1024;

export interface ForwarderDeps {
  dataDir: string;
  stdinText: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export type Decision =
  | 'sent'
  | 'dropped:unregistered'
  | 'dropped:excluded'
  | 'dropped:no_cwd'
  | 'dropped:invalid_payload'
  | 'dropped:fail_closed'
  | 'failed:no_token'
  | 'failed:collector_unreachable'
  | 'failed:collector_rejected';

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export function appendCappedLog(file: string, line: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > LOG_CAP_BYTES) fs.renameSync(file, file + '.1');
    } catch {
      /* no file yet */
    }
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch {
    /* logging must never break the hook */
  }
}

function logDecision(dataDir: string, event: string, sessionId: string, decision: Decision) {
  const safeEvent = /^[A-Za-z]{1,40}$/.test(event) ? event : 'unknown';
  const sid = /^[A-Za-z0-9_-]+$/.test(sessionId) ? sessionId.slice(0, 8) : '-';
  appendCappedLog(
    path.join(dataDir, 'logs', 'forwarder.log'),
    JSON.stringify({ ts: new Date().toISOString(), event: safeEvent, sid, decision }),
  );
}

function logKeyNames(dataDir: string, raw: Record<string, unknown>) {
  const keys = Object.keys(raw).filter((k) => /^[A-Za-z0-9_]{1,64}$/.test(k)).sort();
  const event = typeof raw.hook_event_name === 'string' && /^[A-Za-z]{1,40}$/.test(raw.hook_event_name) ? raw.hook_event_name : 'unknown';
  appendCappedLog(
    path.join(dataDir, 'logs', 'forwarder-keys.log'),
    JSON.stringify({ ts: new Date().toISOString(), event, keys }),
  );
}

export async function runForwarder(deps: ForwarderDeps): Promise<Decision> {
  const { dataDir } = deps;
  const env = deps.env ?? process.env;
  let raw: unknown;
  try {
    raw = JSON.parse(deps.stdinText);
  } catch {
    logDecision(dataDir, 'unknown', '-', 'dropped:invalid_payload');
    return 'dropped:invalid_payload';
  }
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const eventName = typeof r.hook_event_name === 'string' ? r.hook_event_name : 'unknown';
  const sessionId = typeof r.session_id === 'string' ? r.session_id : '-';

  if (env.QAVO_DEBUG_KEYS === '1') logKeyNames(dataDir, r);

  const { policy, failClosed } = parsePolicy(readText(path.join(dataDir, 'capture-policy.json')));
  const resolution = resolveProject(r.cwd, policy, () =>
    parseFolderKeySecret(readText(path.join(dataDir, 'folder-key.secret'))),
  );
  if (resolution.kind === 'drop') {
    const d: Decision = failClosed ? 'dropped:fail_closed' : (`dropped:${resolution.reason}` as Decision);
    logDecision(dataDir, eventName, sessionId, d);
    return d;
  }

  const event = sanitizeHookPayload(raw, resolution, policy);
  if (!event) {
    logDecision(dataDir, eventName, sessionId, 'dropped:invalid_payload');
    return 'dropped:invalid_payload';
  }

  const token = readText(path.join(dataDir, 'token'))?.trim();
  if (!token) {
    logDecision(dataDir, eventName, sessionId, 'failed:no_token');
    return 'failed:no_token';
  }

  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`http://127.0.0.1:${policy.collector.port}/api/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-qavo-token': token, 'x-qavo-forwarder': String(FORWARDER_VERSION) },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    const d: Decision = res.ok ? 'sent' : 'failed:collector_rejected';
    logDecision(dataDir, eventName, sessionId, d);
    return d;
  } catch {
    // 1A: event dropped (sanitized spool + replay arrives in 1B)
    logDecision(dataDir, eventName, sessionId, 'failed:collector_unreachable');
    return 'failed:collector_unreachable';
  }
}
