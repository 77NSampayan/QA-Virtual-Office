import { useCallback, useEffect, useState } from 'react';
import { api, type CiConnection, type CiRun, type CiRuns } from '../api.ts';
import { useLive } from '../live.tsx';
import { MsgLine, useMsg } from './qa/Requirements.tsx';

/** How often the browser asks while auto-refresh is on. The SERVER enforces the same minimum, so this cannot be sped up. */
export const POLL_EVERY_MS = 5 * 60_000 + 5_000;
const STATUS_LABEL: Record<CiRun['status'], string> = { queued: 'Queued', running: 'Running', passed: 'Passed', failed: 'Failed', cancelled: 'Cancelled', other: 'Other' };
const STATUS_CLASS: Record<CiRun['status'], string> = { queued: 'muted', running: '', passed: 'ok-text', failed: 'warn-text', cancelled: 'muted', other: 'muted' };
const dur = (ms: number | null) => (ms === null ? '—' : ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);
const safeLink = (u: string) => /^https:\/\/[^\s]+$/.test(u);

const HELP = {
  github: {
    owner: 'Owner (user or organisation)',
    name: 'Repository',
    ownerHint: 'octo-org',
    nameHint: 'shop-web',
    token: 'In GitHub: Settings → Developer settings → Personal access tokens → Fine-grained tokens. Choose ONLY this repository, and give it only “Actions: Read” (Metadata: Read is added automatically). Nothing else.',
  },
  azure_devops: {
    owner: 'Organisation',
    name: 'Project',
    ownerHint: 'my-org',
    nameHint: 'Shop Web',
    token: 'In Azure DevOps: User settings → Personal access tokens → New token. Choose this organisation, and under Custom defined scopes tick ONLY “Build: Read”. Nothing else.',
  },
} as const;

function Row({ c0, onChanged }: { c0: CiConnection; onChanged: () => void }) {
  const { qaVersion } = useLive();
  const [data, setData] = useState<CiRuns>({ connection: c0, runs: [] });
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [token, setToken] = useState('');
  const m = useMsg();
  const c = data.connection;
  const load = useCallback(() => void api.ciRuns(c0.id).then(setData).catch(() => undefined), [c0.id]);
  useEffect(load, [load, qaVersion]);

  const refresh = (polling: boolean) => {
    setBusy(true);
    if (!polling) m.clear();
    void api
      .refreshCi(c0.id, polling)
      .then((r) => {
        setData({ connection: r.connection, runs: r.runs });
        if (!polling) {
          if (r.ok) m.ok('Runs refreshed.');
          else m.fail(new Error(r.message));
        }
      })
      .catch((e) => {
        if (!polling) m.fail(e);
      })
      .finally(() => setBusy(false));
  };
  // Auto-refresh: only while it is switched on, the server says it has not run out, and this page is visible.
  useEffect(() => {
    if (!c.pollingEnabled) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh(true);
    }, POLL_EVERY_MS);
    return () => window.clearInterval(id);
  }, [c.pollingEnabled, c0.id]); 
  const test = () => {
    setBusy(true);
    m.clear();
    void api
      .testCi(c0.id)
      .then((r) => (r.ok ? m.ok(r.message) : m.fail(new Error(r.message)), setData((d) => ({ ...d, connection: r.connection })), onChanged()))
      .catch(m.fail)
      .finally(() => setBusy(false));
  };
  return (
    <div className="plan quiet" data-ci-connection={`${c.provider}:${c.owner}/${c.name}`}>
      <p>
        <strong>{c.providerLabel}</strong> · <span className="mono">{c.owner}/{c.name}</span>{' '}
        <span className="pill" data-ci-state={c.lastTestOk === null ? 'untested' : c.lastTestOk ? 'ok' : 'failed'}>
          {c.lastTestOk === null ? 'Not tested' : c.lastTestOk ? 'Connected' : 'Test failed'}
        </span>
      </p>
      <p className="muted" data-ci-message>
        {c.lastTestedAt ? `${c.lastTestMessage} (tested ${new Date(c.lastTestedAt).toLocaleString()})` : c.tokenStored ? 'Token saved in Windows protected storage. Press Test connection.' : 'No token is stored: replace the token.'}
      </p>
      <div className="row">
        <button disabled={busy || !c.tokenStored} data-ci-refresh onClick={() => refresh(false)}>
          {busy ? 'Working…' : 'Refresh runs'}
        </button>
        <label className="check">
          <input
            type="checkbox"
            checked={c.pollingEnabled}
            disabled={!c.tokenStored}
            data-ci-polling
            onChange={(e) =>
              void api
                .setCiPolling(c0.id, e.target.checked)
                .then((x) => setData((d) => ({ ...d, connection: x })))
                .catch(m.fail)
            }
          />{' '}
          Refresh automatically every 5 minutes
        </label>
        <button className="ghost" disabled={busy} data-ci-test onClick={test}>
          Test connection
        </button>
        <button className="ghost" data-ci-replace onClick={() => setReplacing(!replacing)}>
          Replace token
        </button>
        <button
          className="danger"
          data-ci-disconnect
          onClick={() => {
            if (!confirm(`Disconnect ${c.owner}/${c.name}? The saved token and the saved runs are deleted from this computer. Nothing changes in ${c.providerLabel}.`)) return;
            void api.disconnectCi(c0.id).then(onChanged).catch(m.fail);
          }}
        >
          Disconnect
        </button>
      </div>
      {c.pollingEnabled && c.pollingUntil && (
        <p className="hint" data-ci-polling-note>
          Auto-refresh is on while this page is open, and stops by itself at {new Date(c.pollingUntil).toLocaleTimeString()} (clicking Refresh runs extends it).
        </p>
      )}
      {replacing && (
        <div className="row">
          <label className="grow">
            New token
            <input type="password" autoComplete="off" spellCheck={false} value={token} maxLength={400} onChange={(e) => setToken(e.target.value)} data-ci-new-token />
          </label>
          <button
            disabled={!token}
            data-ci-save-token
            onClick={() =>
              void api
                .replaceCiToken(c0.id, token)
                .then((x) => (setToken(''), setReplacing(false), m.ok('Token replaced. Press Test connection.'), setData((d) => ({ ...d, connection: x })), onChanged()))
                .catch(m.fail)
            }
          >
            Save token
          </button>
        </div>
      )}
      <MsgLine msg={m.msg} />
      {c.lastRefreshOk === false && (
        <p className="error" data-ci-refresh-error>
          Could not refresh: {c.lastRefreshMessage}
          {c.runsAsOf ? ' The runs below are from the last successful read.' : ''}
        </p>
      )}
      <p className="muted" data-ci-asof>
        {c.runsAsOf ? `Runs as of ${new Date(c.runsAsOf).toLocaleString()}.` : 'No runs read yet. Press Refresh runs.'}
      </p>
      {data.runs.length > 0 && (
        <div className="scroll-x">
          <table data-ci-runs>
            <thead>
              <tr>
                <th>Status</th>
                <th>Pipeline</th>
                <th>Branch</th>
                <th>Commit</th>
                <th>Started</th>
                <th>Duration</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r) => (
                <tr key={r.id} className="static" data-ci-run={r.status}>
                  <td className={STATUS_CLASS[r.status]}>{STATUS_LABEL[r.status]}</td>
                  <td>{r.name}</td>
                  <td className="mono">{r.branch || '—'}</td>
                  <td className="mono">{r.sha7 || '—'}</td>
                  <td className="muted">{r.startedAt ? new Date(r.startedAt).toLocaleString() : '—'}</td>
                  <td>{dur(r.durationMs)}</td>
                  <td>
                    {safeLink(r.url) && (
                      <a href={r.url} target="_blank" rel="noopener noreferrer">
                        Open
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {c.runsAsOf && data.runs.length === 0 && c.lastRefreshOk !== false && <p className="muted">No runs in the last 30 days.</p>}
    </div>
  );
}

/** CI/CD connections (Pass 3, A3a): connect a project to GitHub Actions or Azure DevOps, read-only. The token is never shown again. */
export function CiPanel({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<CiConnection[] | null>(null);
  const [provider, setProvider] = useState<'github' | 'azure_devops'>('github');
  const [owner, setOwner] = useState('');
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const m = useMsg();
  const load = useCallback(() => void api.ciConnections(projectId).then(setItems).catch(() => setItems([])), [projectId]);
  useEffect(load, [load]);
  const h = HELP[provider];
  const connect = async () => {
    setBusy(true);
    m.clear();
    try {
      const c = await api.connectCi(projectId, { provider, owner, name, token });
      setToken(''); // the token leaves the screen the moment it is sent
      setOwner('');
      setName('');
      const t = await api.testCi(c.id);
      if (t.ok) m.ok(t.message);
      else m.fail(new Error(`Saved, but the test failed: ${t.message}`));
    } catch (e) {
      m.fail(e);
    } finally {
      setBusy(false);
      load();
    }
  };
  return (
    <section className="card project-form" data-ci>
      <h3>CI/CD pipelines</h3>
      <p className="hint">
        Connect this project to its <strong>GitHub Actions</strong> or <strong>Azure DevOps</strong> pipelines. It is <strong>read-only</strong>: the app can only look, and never starts, stops or changes a run or a repository. The only things sent are your token and the name you type here, to
        <code> api.github.com</code> or <code>dev.azure.com</code> and nowhere else. The token is kept in Windows protected storage (readable only by your Windows account, not in the database, backups or exports) and is never shown again. Runs are read only when you press Refresh runs (or switch on automatic refresh, which is off until you turn it on). Each run shows its pipeline, branch, status, time, duration and a link; who started it and commit messages are never read or kept.
      </p>
      {items === null ? (
        <p className="muted loading" role="status">Loading…</p>
      ) : (
        items.map((c) => <Row key={c.id} c0={c} onChanged={load} />)
      )}
      <h4>Connect a pipeline</h4>
      <div className="row">
        <label>
          Provider
          <select value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)} data-ci-provider>
            <option value="github">GitHub Actions</option>
            <option value="azure_devops">Azure DevOps</option>
          </select>
        </label>
        <label>
          {h.owner}
          <input value={owner} maxLength={50} placeholder={h.ownerHint} onChange={(e) => setOwner(e.target.value)} data-ci-owner />
        </label>
        <label>
          {h.name}
          <input value={name} maxLength={100} placeholder={h.nameHint} onChange={(e) => setName(e.target.value)} data-ci-name />
        </label>
      </div>
      <label>
        Access token (read-only)
        <input type="password" autoComplete="off" spellCheck={false} value={token} maxLength={400} onChange={(e) => setToken(e.target.value)} data-ci-token />
      </label>
      <p className="hint" data-ci-token-help>
        {h.token} Use a throw-away token you can revoke at any time.
      </p>
      <div className="row">
        <button disabled={busy || !owner.trim() || !name.trim() || !token} data-ci-connect onClick={() => void connect()}>
          {busy ? 'Connecting…' : 'Connect and test'}
        </button>
      </div>
      <MsgLine msg={m.msg} />
    </section>
  );
}
