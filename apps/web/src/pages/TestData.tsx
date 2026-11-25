import { useCallback, useEffect, useState } from 'react';
import { TEST_DATA_ENVIRONMENTS, TEST_DATA_KINDS, TEST_DATA_KIND_LABEL, TEST_DATA_LIMITS, type TestDataKind } from '@qavo/shared';
import { api, type TestDataField, type TestDataInput, type TestDataProfile } from '../api.ts';
import { useLive } from '../live.tsx';
import { Drawer } from '../ui.tsx';
import { MsgLine, useMsg } from './qa/Requirements.tsx';

const KEY = 'qavo.testdata.project';
const readSaved = () => {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
};
const EMPTY: TestDataInput = { name: '', environment: '', description: '', fields: [{ key: '', kind: 'fixed', value: '' }] };

/** The profile as text to paste into a test setup: fixed values as written, secrets as ${NAME}, placeholders as they are. */
const asEnvText = (fields: TestDataField[]) => fields.map((f) => `${f.key}=${f.kind === 'secret_ref' ? '${' + f.value + '}' : f.value}`).join('\n');

/** Masking helper: paste a text, see what would be masked. Nothing is stored. */
function MaskHelper() {
  const [text, setText] = useState('');
  const [res, setRes] = useState<{ masked: string; findings: Array<{ type: string; count: number }> } | null>(null);
  const m = useMsg();
  return (
    <section className="card project-form" data-td-mask>
      <h3>Check a text for personal data</h3>
      <p className="hint">
        Before you copy anything from a real system into a test case, paste it here. It shows the text with personal data and secrets masked (e-mails, phone numbers, card and ID numbers, tokens, passwords…). Nothing you paste here is stored, logged or sent anywhere.
      </p>
      <textarea rows={4} value={text} maxLength={100_000} onChange={(e) => (setText(e.target.value), setRes(null))} data-td-mask-text placeholder="Paste text, a CSV excerpt or a log line…" />
      <div className="row">
        <button
          className="ghost"
          disabled={!text.trim()}
          data-td-mask-btn
          onClick={() =>
            void api
              .checkTestDataText(text)
              .then((r) => (setRes(r), m.clear()))
              .catch(m.fail)
          }
        >
          Check
        </button>
      </div>
      <MsgLine msg={m.msg} />
      {res && (
        <div className="plan" data-td-mask-result>
          <p data-td-mask-summary>{res.findings.length === 0 ? 'Nothing that looks like personal data or a secret was found.' : `Masked: ${res.findings.map((f) => `${f.count} × ${f.type.replace(/_/g, ' ')}`).join(', ')}.`}</p>
          <pre className="prewrap" data-td-mask-output>
            {res.masked}
          </pre>
        </div>
      )}
    </section>
  );
}

function ProfileEditor({ projectId, id, onSaved, onDeleted }: { projectId: string; id: string | null; onSaved: (id: string) => void; onDeleted: () => void }) {
  const [f, setF] = useState<TestDataInput | null>(id ? null : EMPTY);
  const [copied, setCopied] = useState(false);
  const m = useMsg();
  useEffect(() => {
    setCopied(false);
    m.clear();
    if (!id) return setF(EMPTY);
    setF(null);
    void api
      .testDataProfile(id)
      .then((d) => setF({ name: d.name, environment: d.environment, description: d.description, fields: d.fields }))
      .catch(m.fail);
  }, [id]);
  if (!f) return <p className="muted loading" role="status">Loading…</p>;
  const set = (patch: Partial<TestDataInput>) => setF({ ...f, ...patch });
  const setField = (i: number, patch: Partial<TestDataField>) => set({ fields: f.fields.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  return (
    <div className="detail project-form" data-td-editor={id ?? 'new'}>
      <p className="hint">
        Only <strong>fake data</strong> belongs here. A value that looks like real personal data or a secret is refused. Passwords, tokens and keys are never stored: use a <strong>secret reference</strong> (the name of an environment variable) or a placeholder.
      </p>
      <label>
        Name
        <input value={f.name} maxLength={TEST_DATA_LIMITS.nameLen} onChange={(e) => set({ name: e.target.value })} data-td-name />
      </label>
      <label>
        Environment
        <input value={f.environment} maxLength={TEST_DATA_LIMITS.envLen} list="td-envs" onChange={(e) => set({ environment: e.target.value })} data-td-env placeholder="staging" />
        <datalist id="td-envs">
          {TEST_DATA_ENVIRONMENTS.map((e) => (
            <option key={e} value={e} />
          ))}
        </datalist>
      </label>
      <label>
        Description
        <textarea rows={2} value={f.description} maxLength={TEST_DATA_LIMITS.descLen} onChange={(e) => set({ description: e.target.value })} data-td-desc />
      </label>
      <h3>Fields</h3>
      {f.fields.map((x, i) => (
        <div key={i} className="row" data-td-field={i} style={{ alignItems: 'flex-end' }}>
          <label>
            Name
            <input value={x.key} maxLength={TEST_DATA_LIMITS.keyLen} onChange={(e) => setField(i, { key: e.target.value })} data-td-key aria-label={`Field ${i + 1} name`} />
          </label>
          <label>
            Kind
            <select value={x.kind} onChange={(e) => setField(i, { kind: e.target.value as TestDataKind })} data-td-kind aria-label={`Field ${i + 1} kind`}>
              {TEST_DATA_KINDS.map((k) => (
                <option key={k} value={k}>
                  {TEST_DATA_KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="grow">
            {x.kind === 'secret_ref' ? 'Environment variable name' : x.kind === 'placeholder' ? 'Placeholder' : 'Fake value'}
            <input
              value={x.value}
              maxLength={TEST_DATA_LIMITS.valueLen}
              onChange={(e) => setField(i, { value: e.target.value })}
              data-td-value
              aria-label={`Field ${i + 1} value`}
              placeholder={x.kind === 'secret_ref' ? 'SHOP_TEST_PASSWORD' : x.kind === 'placeholder' ? '{{random_email}}' : 'jane.tester@example.test'}
            />
          </label>
          <button className="ghost" onClick={() => set({ fields: f.fields.filter((_, j) => j !== i) })} aria-label={`Remove field ${i + 1}`} data-td-remove>
            Remove
          </button>
        </div>
      ))}
      <div className="row">
        <button className="ghost" disabled={f.fields.length >= TEST_DATA_LIMITS.fields} data-td-add onClick={() => set({ fields: [...f.fields, { key: '', kind: 'fixed', value: '' }] })}>
          Add field
        </button>
      </div>
      <div className="row">
        <button
          disabled={!f.name.trim()}
          data-td-save
          onClick={() =>
            void (id ? api.updateTestData(id, f) : api.createTestData(projectId, f))
              .then((d) => (m.ok('Saved.'), onSaved(d.id)))
              .catch(m.fail)
          }
        >
          Save
        </button>
        {id && (
          <button
            className="ghost"
            data-td-copy
            onClick={() => {
              try {
                void navigator.clipboard.writeText(asEnvText(f.fields)).then(() => setCopied(true));
              } catch {
                m.fail(new Error('Copying is not available here.'));
              }
            }}
          >
            {copied ? 'Copied' : 'Copy as NAME=value lines'}
          </button>
        )}
        {id && (
          <button
            className="danger"
            data-td-delete
            onClick={() => {
              if (!confirm('Delete this test data profile?')) return;
              void api.deleteTestData(id).then(onDeleted).catch(m.fail);
            }}
          >
            Delete
          </button>
        )}
      </div>
      <MsgLine msg={m.msg} />
    </div>
  );
}

/** Test Data Management (Pass 3, D1): fake test data profiles per environment, secret references, and a masking helper. */
export function TestData() {
  const { projects, qaVersion } = useLive();
  const active = projects.filter((p) => !p.archived);
  const [pid, setPid] = useState(readSaved);
  const current = active.find((p) => p.id === pid) ?? active[0];
  const [items, setItems] = useState<TestDataProfile[] | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [env, setEnv] = useState('');
  const currentId = current?.id;
  const load = useCallback(() => {
    if (currentId) void api.testDataProfiles(currentId).then(setItems).catch(() => setItems([]));
  }, [currentId]);
  useEffect(load, [load, qaVersion]);
  useEffect(() => (setEditing(null), setEnv('')), [currentId]);
  useEffect(() => {
    try {
      if (currentId) localStorage.setItem(KEY, currentId);
    } catch {
      /* storage unavailable: fine */
    }
  }, [currentId]);
  const envs = [...new Set((items ?? []).map((p) => p.environment).filter(Boolean))].sort();
  const shown = (items ?? []).filter((p) => !env || p.environment === env);

  return (
    <div className="page" data-page="test-data">
      <h2>Test Data Management</h2>
      {!current ? (
        <section className="card">
          <p>
            Register a project first (<a href="#/projects">Project Rooms</a>): test data profiles belong to a project.
          </p>
        </section>
      ) : (
        <>
          <div className="qa-head">
            <label>
              Project
              <select value={current.id} onChange={(e) => setPid(e.target.value)} data-project-select>
                {active.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.alias}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <MaskHelper />
          <section className="card">
            <h3>Test data profiles</h3>
            <p className="hint">
              A profile is a named set of <strong>fake</strong> values for one environment (for example the test customer for checkout in staging). Production personal information is never stored: values that look real are refused, and secrets are kept only as the name of an environment variable.
            </p>
            <div className="row">
              <button data-td-new onClick={() => setEditing('new')}>
                New profile
              </button>
              {envs.length > 0 && (
                <label>
                  Environment
                  <select value={env} onChange={(e) => setEnv(e.target.value)} data-td-filter>
                    <option value="">All</option>
                    {envs.map((e) => (
                      <option key={e} value={e}>
                        {e}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {items === null ? (
              <p className="muted loading" role="status">Loading…</p>
            ) : (
              <div className="scroll-x">
                <table data-td-table>
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Name</th>
                      <th>Environment</th>
                      <th>Fields</th>
                      <th>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((p) => (
                      <tr key={p.id} className={editing === p.id ? 'selected' : ''} data-td-row={p.code} onClick={() => setEditing(editing === p.id ? null : p.id)}>
                        <td className="mono">{p.code}</td>
                        <td>
                          {p.name}
                          {p.description && <div className="muted">{p.description}</div>}
                        </td>
                        <td>{p.environment || <span className="muted">—</span>}</td>
                        <td>{p.fieldCount}</td>
                        <td className="muted">{new Date(p.updatedAt).toLocaleString()}</td>
                      </tr>
                    ))}
                    {shown.length === 0 && (
                      <tr className="static">
                        <td colSpan={5} className="muted empty">
                          No test data profiles yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          {editing && (
            <Drawer title={editing === 'new' ? 'New profile' : (items?.find((p) => p.id === editing)?.code ?? 'Profile')} onClose={() => setEditing(null)}>
              <ProfileEditor projectId={current.id} id={editing === 'new' ? null : editing} onSaved={(id) => (setEditing(id), load())} onDeleted={() => (setEditing(null), load())} />
            </Drawer>
          )}
        </>
      )}
    </div>
  );
}
