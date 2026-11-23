import { useCallback, useEffect, useState } from 'react';
import { api, ApiDetailError, type PermissionBridgeState } from './api.ts';

const errText = (err: unknown) => (err instanceof ApiDetailError ? (err.detail ? err.code + ': ' + err.detail : err.code) : String(err));
const when = (ms: number) => new Date(ms).toLocaleString();
const RESULT: Record<string, string> = { allowed: 'Allowed by you', denied: 'Denied by you', expired: 'No answer (Claude Code asked in the terminal)' };

interface Plan {
  noChange: boolean;
  willCreateBackup: boolean;
  eventsAdded: string[];
  warning: string | null;
}

/** Settings → Approve permissions from the office (V4b): install the hook, turn the bridge on, see the history. */
export function PermissionBridge() {
  const [s, setS] = useState<PermissionBridgeState | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [ack, setAck] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(() => void api.permissionBridge().then(setS).catch(() => undefined), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);
  if (!s) return null;
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      load();
    } catch (err) {
      setMsg({ ok: false, text: errText(err) });
    }
  };
  const installed = s.hook.state === 'installed';
  return (
    <section className="card" data-permission-bridge>
      <h2>Approve permissions from the office</h2>
      <p>
        Status: hook <strong data-bridge-hook={s.hook.state} style={{ color: installed ? '#4be37c' : '#9aa3b5' }}>{installed ? 'INSTALLED' : 'NOT INSTALLED'}</strong> · bridge{' '}
        <strong data-bridge-status={s.enabled ? 'on' : 'off'} style={{ color: s.enabled ? '#4be37c' : '#9aa3b5' }}>
          {s.enabled ? 'ON' : 'OFF'}
        </strong>
        {s.pending > 0 ? ` · ${s.pending} waiting for you` : ''}
      </p>
      <p className="muted">
        When on, a Claude Code permission request in a <strong>registered project</strong> appears in the office and on the Overview, and you can <strong>allow it once</strong> or <strong>deny</strong> it there instead of in the terminal. <strong>Nothing is ever approved by itself</strong>: if the app is closed, you do not answer within about 110 seconds, or anything goes wrong, Claude Code asks you in the terminal as usual.
      </p>
      <p className={s.toolInputsCapture ? 'muted' : 'error'} data-bridge-capture={s.toolInputsCapture ? 'on' : 'off'}>
        {s.toolInputsCapture
          ? 'Tool-input capture is ON, so a request shows what it wants to do (redacted, paths masked) and you can allow it.'
          : 'Tool-input capture is OFF (Settings → Privacy → Tool inputs). Requests then arrive without details, so here you can only deny them or answer in the terminal: approving something you cannot see is not offered.'}
      </p>

      <div className="row">
        {installed ? (
          <button className="ghost" data-bridge-uninstall onClick={() => void act(() => api.permissionHook('uninstall'), 'Permission hook removed.')}>
            Remove the permission hook
          </button>
        ) : (
          <button
            data-bridge-plan
            onClick={() =>
              void api
                .permissionPlan('install')
                .then((p) => {
                  setPlan(p as unknown as Plan);
                  setAck(false);
                })
                .catch((e) => setMsg({ ok: false, text: errText(e) }))
            }
          >
            Install the permission hook…
          </button>
        )}
        {s.enabled ? (
          <button className="ghost" data-bridge-off onClick={() => void act(() => api.setPermissionBridge(false), 'Bridge turned off.')}>
            Turn off
          </button>
        ) : (
          <button
            className="ghost"
            data-bridge-on
            disabled={!installed}
            title={installed ? '' : 'Install the permission hook first'}
            onClick={() => {
              if (confirm('Answer Claude Code permission requests from the office? Nothing is approved automatically, and unanswered requests fall back to the terminal.')) void act(() => api.setPermissionBridge(true, true), 'Bridge turned on.');
            }}
          >
            Turn on the bridge
          </button>
        )}
      </div>

      {plan && !installed && (
        <div className="plan" data-bridge-plan-box>
          <p>
            <strong>Review before installing.</strong> This adds one synchronous hook on <code>{plan.eventsAdded.join(', ') || 'PermissionRequest'}</code> to your Claude Code user settings
            {plan.willCreateBackup ? ' (a timestamped backup is made first)' : ''}.
          </p>
          {plan.warning && <pre>{plan.warning}</pre>}
          <label className="check">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-bridge-ack />
            <span>I understand: it never approves anything by itself, and Claude Code waits for it while a request is open.</span>
          </label>
          <div className="row">
            <button
              disabled={!ack}
              data-bridge-install
              onClick={() =>
                void act(async () => {
                  await api.permissionHook('install', true);
                  setPlan(null);
                }, 'Permission hook installed. Turn the bridge on to use it.')
              }
            >
              Install
            </button>
            <button className="ghost" onClick={() => setPlan(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {msg && <p className={msg.ok ? 'ok' : 'error'}>{msg.text}</p>}

      <h3>Recent requests</h3>
      <p className="muted">Only the tool, project and what happened are kept (never the command), and for one week.</p>
      {s.recent.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <div className="scroll-x">
          <table data-bridge-recent>
            <thead>
              <tr>
                <th>When</th>
                <th>Tool</th>
                <th>Project</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {s.recent.map((r, i) => (
                <tr key={`${r.at}-${i}`} style={{ cursor: 'default' }}>
                  <td className="muted">{when(r.at)}</td>
                  <td className="mono">{r.tool}</td>
                  <td>{r.project ?? '—'}</td>
                  <td>{RESULT[r.status] ?? r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
