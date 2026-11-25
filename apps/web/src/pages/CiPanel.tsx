import { useCallback, useEffect, useState } from 'react';
import { api, type CiConnection } from '../api.ts';
import { MsgLine, useMsg } from './qa/Requirements.tsx';

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

function Row({ c, onChanged }: { c: CiConnection; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [token, setToken] = useState('');
  const m = useMsg();
  const test = () => {
    setBusy(true);
    m.clear();
    void api
      .testCi(c.id)
      .then((r) => (r.ok ? m.ok(r.message) : m.fail(new Error(r.message)), onChanged()))
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
        <button className="ghost" disabled={busy} data-ci-test onClick={test}>
          {busy ? 'Testing…' : 'Test connection'}
        </button>
        <button className="ghost" data-ci-replace onClick={() => setReplacing(!replacing)}>
          Replace token
        </button>
        <button
          className="danger"
          data-ci-disconnect
          onClick={() => {
            if (!confirm(`Disconnect ${c.owner}/${c.name}? The saved token is deleted from this computer. Nothing changes in ${c.providerLabel}.`)) return;
            void api.disconnectCi(c.id).then(onChanged).catch(m.fail);
          }}
        >
          Disconnect
        </button>
      </div>
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
                .replaceCiToken(c.id, token)
                .then(() => (setToken(''), setReplacing(false), m.ok('Token replaced. Press Test connection.'), onChanged()))
                .catch(m.fail)
            }
          >
            Save token
          </button>
        </div>
      )}
      <MsgLine msg={m.msg} />
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
        <code> api.github.com</code> or <code>dev.azure.com</code> and nowhere else. The token is kept in Windows protected storage (readable only by your Windows account, not in the database, backups or exports) and is never shown again. This step connects and tests; showing runs comes next.
      </p>
      {items === null ? (
        <p className="muted loading" role="status">Loading…</p>
      ) : (
        items.map((c) => <Row key={c.id} c={c} onChanged={load} />)
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
