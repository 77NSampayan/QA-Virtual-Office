import { Fragment, useCallback, useEffect, useState } from 'react';
import { PRIORITIES, TEST_CASE_STATUSES, TEST_CASE_STATUS_LABEL, TEST_TYPES, TEST_TYPE_LABEL, nextStatuses, type TestCaseStatus } from '@qavo/shared';
import { api, ApiDetailError, type QaRequirement, type QaTestCase, type QaTestCaseDetail, type QaTestCaseInput } from '../../api.ts';
import { useLive } from '../../live.tsx';
import { agoIso, useNow } from '../../ui.tsx';
import { errText, MsgLine } from './Requirements.tsx';

const STATUS_COLOR: Record<TestCaseStatus, string> = { draft: '#9aa3b5', in_review: '#ffd54a', approved: '#4be37c', rejected: '#ff5d6c' };
const MISSING_LABEL: Record<string, string> = { title_required: 'a title', steps_required: 'at least one step', expected_result_required: 'an expected result' };

export const StatusBadge = ({ status }: { status: TestCaseStatus }) => (
  <span className="pill" style={{ color: STATUS_COLOR[status] }} data-tc-status={status}>
    {TEST_CASE_STATUS_LABEL[status]}
  </span>
);

interface FormState {
  scenario: string;
  title: string;
  description: string;
  preconditions: string;
  steps: string;
  testData: string;
  expectedResult: string;
  priority: string;
  testType: string;
  assignedTester: string;
  requirementIds: string[];
}
const EMPTY: FormState = { scenario: '', title: '', description: '', preconditions: '', steps: '', testData: '', expectedResult: '', priority: 'medium', testType: 'positive', assignedTester: '', requirementIds: [] };
/** Only the editable fields: the server rejects anything else (status, code, authorship, version...). */
const toForm = (t: QaTestCase): FormState => ({
  scenario: t.scenario,
  title: t.title,
  description: t.description,
  preconditions: t.preconditions,
  steps: t.steps.join('\n'),
  testData: t.testData,
  expectedResult: t.expectedResult,
  priority: t.priority,
  testType: t.testType,
  assignedTester: t.assignedTester,
  requirementIds: [...t.requirementIds],
});
const toInput = (f: FormState): QaTestCaseInput => ({ ...f, steps: f.steps.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) });

function TestCaseForm({ projectId, requirements, initial, onSaved, onCancel }: { projectId: string; requirements: QaRequirement[]; initial?: QaTestCase; onSaved: (t: QaTestCase) => void; onCancel: () => void }) {
  const [f, setF] = useState<FormState>(initial ? toForm(initial) : EMPTY);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((p) => ({ ...p, [k]: v }));
  const toggleReq = (id: string) => set('requirementIds', f.requirementIds.includes(id) ? f.requirementIds.filter((x) => x !== id) : [...f.requirementIds, id]);
  return (
    <form
      className="project-form"
      data-tc-form
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          onSaved(initial ? await api.updateTestCase(initial.id, toInput(f)) : await api.createTestCase(projectId, toInput(f)));
        } catch (err) {
          setMsg({ ok: false, text: errText(err) });
        }
      }}
    >
      {initial && initial.status !== 'draft' && <p className="hint">Saving changes returns this test case to <strong>Draft</strong>: it needs a new review before it can be approved again.</p>}
      <div className="row">
        <label style={{ flex: 1, minWidth: 220 }}>
          Title
          <input value={f.title} onChange={(e) => set('title', e.target.value)} required maxLength={200} data-field="title" />
        </label>
        <label>
          Test scenario
          <input value={f.scenario} onChange={(e) => set('scenario', e.target.value)} maxLength={200} placeholder="e.g. Authentication" />
        </label>
      </div>
      <div className="row">
        <label>
          Test type
          <select value={f.testType} onChange={(e) => set('testType', e.target.value)}>
            {TEST_TYPES.map((t) => (
              <option key={t} value={t}>
                {TEST_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Priority
          <select value={f.priority} onChange={(e) => set('priority', e.target.value)}>
            {PRIORITIES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label>
          Assigned tester
          <input value={f.assignedTester} onChange={(e) => set('assignedTester', e.target.value)} maxLength={100} />
        </label>
      </div>
      <label>
        Description
        <textarea rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} />
      </label>
      <label>
        Preconditions
        <textarea rows={2} value={f.preconditions} onChange={(e) => set('preconditions', e.target.value)} />
      </label>
      <label>
        Test steps (one per line)
        <textarea rows={5} value={f.steps} onChange={(e) => set('steps', e.target.value)} data-field="steps" />
      </label>
      <label>
        Test data (use fake or masked data, never real customer data)
        <textarea rows={2} value={f.testData} onChange={(e) => set('testData', e.target.value)} />
      </label>
      <label>
        Expected result
        <textarea rows={2} value={f.expectedResult} onChange={(e) => set('expectedResult', e.target.value)} data-field="expectedResult" />
      </label>
      <fieldset className="req-picker">
        <legend>Requirement references</legend>
        {requirements.length === 0 && <span className="muted">No requirements in this project yet.</span>}
        {requirements.map((r) => (
          <label className="check" key={r.id}>
            <input type="checkbox" checked={f.requirementIds.includes(r.id)} onChange={() => toggleReq(r.id)} />
            <span>
              <strong>{r.ref}</strong> {r.title}
            </span>
          </label>
        ))}
      </fieldset>
      <div className="row">
        <button>{initial ? 'Save changes' : 'Create draft'}</button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <MsgLine msg={msg} />
    </form>
  );
}

function Detail({ id, requirements, onChanged }: { id: string; requirements: QaRequirement[]; onChanged: () => void }) {
  const { qaVersion, projects } = useLive();
  const now = useNow();
  const [d, setD] = useState<QaTestCaseDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(() => void api.testCase(id).then(setD).catch(() => setD(null)), [id]);
  useEffect(load, [load, qaVersion]);
  void projects;
  if (!d) return <p className="muted">Loading…</p>;
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      setNote('');
      load();
      onChanged();
    } catch (err) {
      if (err instanceof ApiDetailError && err.code === 'approval_requirements_missing') {
        setMsg({ ok: false, text: `Before this can be approved it needs ${err.detail.split(',').map((c) => MISSING_LABEL[c] ?? c).join(', ')}.` });
      } else if (err instanceof ApiDetailError && err.code === 'note_required') {
        setMsg({ ok: false, text: 'Say why you are rejecting it (type a reason in the note box).' });
      } else setMsg({ ok: false, text: errText(err) });
    }
  };
  const targets = nextStatuses(d.status);
  const label: Record<string, string> = { in_review: 'Submit for review', approved: 'Approve', rejected: 'Reject', draft: d.status === 'approved' ? 'Revoke approval (back to draft)' : 'Back to draft' };

  if (editing) {
    return (
      <TestCaseForm
        projectId={d.projectId}
        requirements={requirements}
        initial={d}
        onCancel={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          load();
          onChanged();
        }}
      />
    );
  }
  return (
    <div className="detail" data-tc-detail={d.code}>
      <div className="row" style={{ alignItems: 'center' }}>
        <StatusBadge status={d.status} />
        {d.authoredBy === 'agent' && <span className="pill soon" title="Created by a Claude Code agent; it needs your review before it can be approved">Agent draft: needs your review</span>}
        {d.archived && <span className="pill prio">archived</span>}
        <span className="muted">
          v{d.version} · execution status: <strong>{d.executionStatus}</strong>
          {d.approvedAt ? ` · approved by you ${agoIso(d.approvedAt, now)}` : ''}
        </span>
      </div>
      {d.status === 'rejected' && d.rejectionNote && <p className="error">Rejected: {d.rejectionNote}</p>}
      <dl className="fields">
        {d.scenario && (<><dt>Scenario</dt><dd>{d.scenario}</dd></>)}
        {d.description && (<><dt>Description</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{d.description}</dd></>)}
        {d.preconditions && (<><dt>Preconditions</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{d.preconditions}</dd></>)}
        <dt>Steps</dt>
        <dd>{d.steps.length ? <ol>{d.steps.map((s, i) => <li key={i}>{s}</li>)}</ol> : <span className="muted">No steps yet.</span>}</dd>
        {d.testData && (<><dt>Test data</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{d.testData}</dd></>)}
        <dt>Expected result</dt>
        <dd style={{ whiteSpace: 'pre-wrap' }}>{d.expectedResult || <span className="muted">Not written yet.</span>}</dd>
        <dt>Type · priority · tester</dt>
        <dd>
          {TEST_TYPE_LABEL[d.testType as keyof typeof TEST_TYPE_LABEL] ?? d.testType} · {d.priority} · {d.assignedTester || 'unassigned'}
        </dd>
        <dt>Requirements</dt>
        <dd>{d.requirements.length ? d.requirements.map((r) => `${r.ref} ${r.title}`).join('; ') : <span className="muted">Not linked to a requirement.</span>}</dd>
      </dl>

      {!d.archived && (
        <div className="plan" style={{ borderColor: 'var(--line)', background: 'transparent' }}>
          <p className="hint" style={{ marginBottom: 6 }}>
            Only you can move a test case through review. Agents can write drafts but cannot approve or reject them.
          </p>
          <div className="row">
            {(targets.includes('rejected') || targets.includes('approved')) && <input placeholder="Note / reason (required to reject)" value={note} onChange={(e) => setNote(e.target.value)} style={{ minWidth: 240 }} />}
            {targets.map((to) => (
              <button key={to} className={to === 'approved' || to === 'in_review' ? '' : 'ghost'} data-transition={to} onClick={() => void act(() => api.transitionTestCase(id, to, note), `${TEST_CASE_STATUS_LABEL[to]}.`)}>
                {label[to]}
              </button>
            ))}
            <button className="ghost" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button className="ghost" onClick={() => void act(() => api.archiveTestCase(id, true), 'Archived.')}>
              Archive
            </button>
          </div>
        </div>
      )}
      {d.archived && (
        <button className="ghost" onClick={() => void act(() => api.archiveTestCase(id, false), 'Restored.')}>
          Restore
        </button>
      )}
      <MsgLine msg={msg} />

      <h3>History (cannot be edited)</h3>
      <ul className="feed" data-history>
        {[...d.history].reverse().map((h) => (
          <li key={h.id}>
            <span className="mono muted">{agoIso(h.at, now)}</span> <strong>{h.actor}</strong> {h.action}
            {h.fromStatus || h.toStatus ? ` (${h.fromStatus ?? '—'} → ${h.toStatus ?? '—'})` : ''}
            {Object.keys(h.changes).length ? <span className="muted"> · changed: {Object.keys(h.changes).join(', ')}</span> : null}
            {h.note ? <span className="muted"> · “{h.note}”</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TestCasesPanel({ projectId }: { projectId: string }) {
  const { qaVersion } = useLive();
  const [items, setItems] = useState<QaTestCase[]>([]);
  const [reqs, setReqs] = useState<QaRequirement[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [filters, setFilters] = useState({ status: '', testType: '', priority: '', requirementId: '', authoredBy: '', q: '', includeArchived: '' });
  const load = useCallback(() => {
    void api.testCases(projectId, filters).then(setItems).catch(() => setItems([]));
    void api.requirements(projectId).then(setReqs).catch(() => setReqs([]));
  }, [projectId, filters]);
  useEffect(load, [load, qaVersion]);
  useEffect(() => setOpen(null), [projectId]);
  const set = (k: keyof typeof filters, v: string) => setFilters((p) => ({ ...p, [k]: v }));

  return (
    <div data-panel="test-cases">
      <div className="row toolbar">
        <button className={creating ? 'tab on' : 'tab'} onClick={() => setCreating(!creating)}>
          New test case
        </button>
        <input placeholder="Search…" value={filters.q} onChange={(e) => set('q', e.target.value)} style={{ width: 160 }} />
        <select value={filters.status} onChange={(e) => set('status', e.target.value)} aria-label="Status filter">
          <option value="">All statuses</option>
          {TEST_CASE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {TEST_CASE_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <select value={filters.testType} onChange={(e) => set('testType', e.target.value)} aria-label="Type filter">
          <option value="">All types</option>
          {TEST_TYPES.map((t) => (
            <option key={t} value={t}>
              {TEST_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <select value={filters.priority} onChange={(e) => set('priority', e.target.value)} aria-label="Priority filter">
          <option value="">All priorities</option>
          {PRIORITIES.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <select value={filters.requirementId} onChange={(e) => set('requirementId', e.target.value)} aria-label="Requirement filter">
          <option value="">Any requirement</option>
          {reqs.map((r) => (
            <option key={r.id} value={r.id}>
              {r.ref}
            </option>
          ))}
        </select>
        <select value={filters.authoredBy} onChange={(e) => set('authoredBy', e.target.value)} aria-label="Author filter">
          <option value="">Any author</option>
          <option value="human">Written by me</option>
          <option value="agent">Agent drafts</option>
        </select>
        <label className="check" style={{ margin: 0 }}>
          <input type="checkbox" checked={filters.includeArchived === 'true'} onChange={(e) => set('includeArchived', e.target.checked ? 'true' : '')} />
          Archived
        </label>
        <span className="muted">{items.length} test case(s)</span>
      </div>
      {creating && (
        <section className="card">
          <TestCaseForm
            projectId={projectId}
            requirements={reqs}
            onCancel={() => setCreating(false)}
            onSaved={(t) => {
              setCreating(false);
              setOpen(t.id);
              load();
            }}
          />
        </section>
      )}
      <section className="card">
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Title</th>
                <th>Type</th>
                <th>Priority</th>
                <th>Review</th>
                <th>Execution</th>
                <th>Requirements</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <Fragment key={t.id}>
                  <tr className={open === t.id ? 'selected' : ''} data-tc={t.code} onClick={() => setOpen(open === t.id ? null : t.id)}>
                    <td className="mono">{t.code}</td>
                    <td>
                      {t.title}
                      {t.authoredBy === 'agent' && <span className="pill soon"> agent</span>}
                      {t.archived && <span className="muted"> (archived)</span>}
                    </td>
                    <td>{TEST_TYPE_LABEL[t.testType as keyof typeof TEST_TYPE_LABEL] ?? t.testType}</td>
                    <td>{t.priority}</td>
                    <td>
                      <StatusBadge status={t.status} />
                    </td>
                    <td className="muted">{t.executionStatus}</td>
                    <td>{t.requirementRefs.length ? t.requirementRefs.join(', ') : <span className="muted">—</span>}</td>
                  </tr>
                  {open === t.id && (
                    <tr style={{ cursor: 'default' }}>
                      <td colSpan={7}>
                        <Detail id={t.id} requirements={reqs} onChanged={load} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {items.length === 0 && (
                <tr style={{ cursor: 'default' }}>
                  <td colSpan={7} className="muted">
                    No test cases match. Create a draft; it must be reviewed and approved by you before it counts as approved.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
