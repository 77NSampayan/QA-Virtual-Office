import { useCallback, useEffect, useState } from 'react';
import { api, ApiDetailError, type AgentSettings } from './api.ts';

const errText = (err: unknown) => (err instanceof ApiDetailError ? (err.detail ? `${err.code}: ${err.detail}` : err.code) : String(err));
const when = (iso: string) => new Date(iso).toLocaleString();

/** Settings → Agent access (MCP): off by default; a person turns it on, sees what agents did, and can revoke the token. */
export function AgentAccess() {
  const [s, setS] = useState<AgentSettings | null>(null);
  const [setup, setSetup] = useState<{ command: string; removeCommand: string } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(() => void api.agentSettings().then(setS).catch(() => undefined), []);
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
  return (
    <section className="card" data-agent-access>
      <h2>Agent access (MCP)</h2>
      <p>
        Status:{' '}
        <strong data-agent-status={s.enabled ? 'on' : 'off'} style={{ color: s.enabled ? '#4be37c' : '#9aa3b5' }}>
          {s.enabled ? 'ON' : 'OFF'}
        </strong>
      </p>
      <p className="muted">
        When on, Claude Code agents you connect through the <code>qa-office</code> MCP server can read this QA data and create <strong>drafts</strong>: requirements, draft test cases, defect reports, tasks and notes. They can never approve a test case,
        mark a test passed, close or reject a defect, or complete a task: only you can. Everything agents read is redacted, and nothing here lets an agent see project folder paths. Use fake or masked test data only.
      </p>
      <div className="row">
        {s.enabled ? (
          <button className="ghost" data-agent-off onClick={() => void act(() => api.setAgentAccess(false), 'Agent access turned off.')}>
            Turn off
          </button>
        ) : (
          <button
            data-agent-on
            onClick={() => {
              if (confirm('Allow connected Claude Code agents to read QA data and create drafts, defect reports and tasks? They can never approve, pass, close or complete anything.')) {
                void act(() => api.setAgentAccess(true, true), 'Agent access turned on.');
              }
            }}
          >
            Turn on agent access
          </button>
        )}
        <button
          className="ghost"
          data-agent-rotate
          onClick={() => {
            if (confirm('Revoke the current agent token and create a new one? Connected agents pick up the new token automatically; anything holding the old one stops working.')) void act(() => api.rotateAgentToken(), 'Agent token replaced.');
          }}
        >
          Revoke and replace token
        </button>
      </div>
      {s.lastRotatedAt && <p className="muted">Token last replaced {when(s.lastRotatedAt)}.</p>}

      <h3>Connect Claude Code</h3>
      {!s.mcpInstalled && <p className="error">The MCP server file is missing. Run <code>npm run build</code>, then restart this app.</p>}
      <p className="muted">
        You run this once in a terminal; the app never changes your Claude Code configuration for you. It registers the server for your user, so it also works outside this project.
      </p>
      {setup ? (
        <div data-agent-setup>
          <pre>{setup.command}</pre>
          <div className="row">
            <button className="ghost" onClick={() => void navigator.clipboard?.writeText(setup.command).then(() => setMsg({ ok: true, text: 'Command copied.' }))}>
              Copy command
            </button>
            <button className="ghost" onClick={() => setSetup(null)}>
              Hide
            </button>
          </div>
          <p className="muted">
            To disconnect later: <code>{setup.removeCommand}</code>
          </p>
        </div>
      ) : (
        <button className="ghost" data-agent-show-setup onClick={() => void api.agentSetup().then(setSetup).catch((e) => setMsg({ ok: false, text: errText(e) }))}>
          Show the setup command
        </button>
      )}

      <h3>What agents can do ({s.tools.length} tools)</h3>
      <p className="muted" data-agent-tools>
        {s.tools.join(' · ')}
      </p>

      <h3>Recent agent activity</h3>
      <p className="muted">Only the tool, project and outcome are recorded, never what was written or read.</p>
      {s.activity.length === 0 ? (
        <p className="muted">No agent has used this yet.</p>
      ) : (
        <div className="scroll-x">
          <table data-agent-activity>
            <thead>
              <tr>
                <th>When</th>
                <th>Agent</th>
                <th>Tool</th>
                <th>Project</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {s.activity.map((a, i) => (
                <tr key={`${a.at}-${i}`} style={{ cursor: 'default' }}>
                  <td className="muted">{when(a.at)}</td>
                  <td>{a.agent ?? <span className="muted">shared token</span>}</td>
                  <td className="mono">{a.tool}</td>
                  <td>{a.project ?? '—'}</td>
                  <td style={{ color: a.outcome === 'ok' ? '#4be37c' : a.outcome === 'denied' ? '#ff9f43' : '#ff5d6c' }}>
                    {a.outcome}
                    {a.code ? ` (${a.code})` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {msg && <p className={msg.ok ? 'ok' : 'error'}>{msg.text}</p>}
    </section>
  );
}
