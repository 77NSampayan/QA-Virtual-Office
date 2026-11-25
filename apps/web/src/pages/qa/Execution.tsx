import { Fragment, useCallback, useEffect, useState } from 'react';
import { EVIDENCE_MAX_BYTES, EXECUTION_STATUS_LABEL, type ExecutionStatus } from '@qavo/shared';
import { api, type QaDefect, type QaExecution, type QaExecutionDetail, type QaRun } from '../../api.ts';
import { useLive } from '../../live.tsx';
import { MsgLine, useMsg } from './Requirements.tsx';

const COLOR: Record<string, string> = {
  not_run: '#9aa3b5',
  in_progress: '#5ad1ff',
  passed: '#4be37c',
  failed: '#ff5d6c',
  blocked: '#ff9f43',
  skipped: '#b9a3ff',
};
const NOTE_NEEDED = ['failed', 'blocked', 'skipped'];

export const ExecBadge = ({ status }: { status: string }) => (
  <span className="pill" style={{ color: COLOR[status] ?? '#9aa3b5' }} data-exec-status={status}>
    {EXECUTION_STATUS_LABEL[status as ExecutionStatus] ?? status}
  </span>
);

const size = (n: number | null) => (n === null ? '' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function ExecutionDetail({ id, runOpen, onChanged }: { id: string; runOpen: boolean; onChanged: () => void }) {
  const { qaVersion } = useLive();
  const [d, setD] = useState<QaExecutionDetail | null>(null);
  const [note, setNote] = useState('');
  const [actual, setActual] = useState('');
  const [evLabel, setEvLabel] = useState('');
  const [evBody, setEvBody] = useState('');
  const [defects, setDefects] = useState<QaDefect[]>([]);
  const m = useMsg();
  const load = useCallback(() => {
    void api.execution(id).then((x) => {
      setD(x);
      void api.defects(x.run.projectId, { executionId: id }).then(setDefects).catch(() => setDefects([]));
    }).catch(() => setD(null));
  }, [id]);
  useEffect(load, [load, qaVersion]);
  if (!d) return <p className="muted loading" role="status">Loading…</p>;

  const set = async (status: string) => {
    try {
      await api.setResult(id, { status, note, ...(actual ? { actualResult: actual } : {}) });
      setNote('');
      m.ok(`Marked ${EXECUTION_STATUS_LABEL[status as ExecutionStatus]}.`);
      load();
      onChanged();
    } catch (err) {
      m.fail(err);
    }
  };
  const addNote = async () => {
    try {
      await api.addEvidenceNote(id, { label: evLabel, body: evBody });
      setEvLabel('');
      setEvBody('');
      m.ok('Evidence note added (secrets and personal data are redacted automatically).');
      load();
      onChanged();
    } catch (err) {
      m.fail(err);
    }
  };
  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > EVIDENCE_MAX_BYTES) return m.fail(new Error(`File is larger than ${EVIDENCE_MAX_BYTES / 1024 / 1024} MB`));
    try {
      await api.addEvidenceFile(id, { fileName: file.name, label: evLabel, dataBase64: await toBase64(file) });
      setEvLabel('');
      m.ok('File attached.');
      load();
      onChanged();
    } catch (err) {
      m.fail(err);
    }
  };
  const raiseDefect = async () => {
    try {
      const x = await api.defectFromExecution(id);
      m.ok(`${x.code} raised from this failed test (open it in the Defects tab).`);
      load();
    } catch (err) {
      m.fail(err);
    }
  };
  const remove = async (evId: string) => {
    try {
      await api.deleteEvidence(evId);
      load();
      onChanged();
    } catch (err) {
      m.fail(err);
    }
  };

  return (
    <div className="detail" data-execution-detail={d.testCaseCode}>
      {d.caseChanged && <p className="error">This test case was edited or un-approved after it was added to the run (run used version {d.caseVersion}). Check it before trusting the result.</p>}
      {d.preconditions && <p><strong>Preconditions:</strong> {d.preconditions}</p>}
      <ol>
        {d.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      {d.testData && <p><strong>Test data:</strong> {d.testData}</p>}
      <p><strong>Expected:</strong> {d.expectedResult}</p>

      {runOpen ? (
        <div className="project-form" data-result-form>
          <label>
            Actual result
            <textarea rows={2} value={actual} onChange={(e) => setActual(e.target.value)} placeholder={d.actualResult || 'What actually happened'} maxLength={10000} />
          </label>
          <label>
            Note (required for Failed, Blocked, Skipped and for changing a finished result)
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={5000} data-result-note />
          </label>
          <div className="row">
            {(['in_progress', 'passed', 'failed', 'blocked', 'skipped'] as const).map((s) => (
              <button key={s} className={s === 'passed' ? '' : 'ghost'} data-set-result={s} disabled={d.status === s || (NOTE_NEEDED.includes(s) && !note.trim())} onClick={() => void set(s)}>
                {EXECUTION_STATUS_LABEL[s]}
              </button>
            ))}
          </div>
          <p className="hint">Only you can mark a test Passed or Skipped. Agents can never do it for you.</p>
        </div>
      ) : (
        <p className="muted">This run is closed: results and evidence can no longer be changed.</p>
      )}
      {d.status !== 'not_run' && (
        <p>
          Current: <ExecBadge status={d.status} /> by {d.executedBy ?? '—'} ({d.executorKind.replace('_', ' ')}){d.actualResult ? ` · actual: ${d.actualResult}` : ''}
          {d.note ? ` · note: ${d.note}` : ''}
        </p>
      )}

      {d.status === 'failed' && (
        <div data-defects-box>
          <h4>Defects ({defects.length})</h4>
          {defects.length > 0 && (
            <ul>
              {defects.map((x) => (
                <li key={x.id} data-linked-defect={x.code}>
                  <strong>{x.code}</strong> {x.title} <span className="muted">· {x.status}</span>
                </li>
              ))}
            </ul>
          )}
          <button className="ghost" onClick={() => void raiseDefect()} data-raise-defect>
            Raise defect from this failed test
          </button>
        </div>
      )}

      <h4>Evidence ({d.evidence.length})</h4>
      {d.evidence.length === 0 && <p className="muted">No evidence yet.</p>}
      <ul data-evidence-list>
        {d.evidence.map((e) => (
          <li key={e.id} data-evidence={e.kind}>
            <strong>{e.label || (e.kind === 'file' ? e.fileName : 'Note')}</strong>{' '}
            {e.kind === 'file' ? (
              <>
                <a href={`/api/evidence/${e.id}/file`} download>
                  {e.fileName}
                </a>{' '}
                <span className="muted">
                  {size(e.sizeBytes)} · sha256 {e.sha256?.slice(0, 12)}…{e.redacted ? ' · text redacted' : ''}
                </span>
              </>
            ) : (
              <span>
                {e.body}
                {e.redacted ? <span className="muted"> (redacted)</span> : null}
              </span>
            )}{' '}
            <span className="muted">· {e.createdBy}</span>
            {runOpen && (
              <button className="ghost small" onClick={() => void remove(e.id)} aria-label={`Delete evidence ${e.label || e.fileName || 'note'}`}>
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
      {runOpen && (
        <div className="project-form" data-evidence-form>
          <label>
            Label (optional)
            <input value={evLabel} onChange={(e) => setEvLabel(e.target.value)} maxLength={120} />
          </label>
          <label>
            Evidence note
            <textarea rows={2} value={evBody} onChange={(e) => setEvBody(e.target.value)} maxLength={20000} data-evidence-body />
          </label>
          <div className="row">
            <button className="ghost" disabled={!evBody.trim()} onClick={() => void addNote()} data-add-evidence-note>
              Add note
            </button>
            <label className="ghost-file">
              Attach file
              <input type="file" accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.log,.json,.csv" onChange={(e) => void upload(e.target.files?.[0])} data-evidence-file />
            </label>
          </div>
          <p className="hint">
            Notes and text files are redacted automatically. Screenshots and PDFs cannot be, so check them for personal data before attaching. Up to {EVIDENCE_MAX_BYTES / 1024 / 1024} MB each, stored only on this PC.
          </p>
        </div>
      )}
      <MsgLine msg={m.msg} />

      <h4>History</h4>
      <ul className="muted">
        {d.history.map((h) => (
          <li key={h.id}>
            {new Date(h.at).toLocaleString()} · {h.actor} · {h.action}
            {h.toStatus ? ` → ${EXECUTION_STATUS_LABEL[h.toStatus as ExecutionStatus] ?? h.toStatus}` : ''}
            {h.note ? ` — ${h.note}` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RunBoard({ runId, onChanged }: { runId: string; onChanged: () => void }) {
  const { qaVersion } = useLive();
  const [run, setRun] = useState<(QaRun & { executions: QaExecution[] }) | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const m = useMsg();
  const load = useCallback(() => void api.run(runId).then(setRun).catch(() => setRun(null)), [runId]);
  useEffect(load, [load, qaVersion]);
  if (!run) return <p className="muted loading" role="status">Loading…</p>;
  const c = run.counts;
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      m.ok(ok);
      load();
      onChanged();
    } catch (err) {
      m.fail(err);
    }
  };
  return (
    <section className="card" data-run={run.code}>
      <h3>
        {run.code} · {run.name} <span className="pill">{run.status}</span>
      </h3>
      <p className="muted">
        {run.environment && `Environment: ${run.environment} · `}
        {run.build && `Build: ${run.build} · `}
        {c.total} test(s): {c.passed} passed, {c.failed} failed, {c.blocked} blocked, {c.skipped} skipped, {c.in_progress} in progress, {c.not_run} not run
      </p>
      {run.status === 'open' && (
        <div className="row">
          <button
            className="ghost"
            onClick={() => void act(async () => { const r = await api.addCasesToRun(run.id, { addAllApproved: true }); m.ok(`${r.added} added${r.skipped.length ? `; ${r.skipped.length} skipped` : ''}.`); }, '')}
          >
            Add all approved test cases
          </button>
          <button className="ghost" onClick={() => void act(() => api.closeRun(run.id), 'Run closed.')} data-close-run>
            Close run
          </button>
        </div>
      )}
      <MsgLine msg={m.msg} />
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Test case</th>
              <th>Priority</th>
              <th>Result</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {run.executions.map((e) => (
              <Fragment key={e.id}>
                <tr className={open === e.id ? 'selected' : ''} data-exec={e.testCaseCode} onClick={() => setOpen(open === e.id ? null : e.id)}>
                  <td className="mono">{e.testCaseCode}</td>
                  <td>
                    {e.title}
                    {e.caseChanged && <span className="pill soon"> changed</span>}
                  </td>
                  <td>{e.priority}</td>
                  <td>
                    <ExecBadge status={e.status} />
                  </td>
                  <td>{e.evidenceCount || <span className="muted">—</span>}</td>
                </tr>
                {open === e.id && (
                  <tr className="static">
                    <td colSpan={5}>
                      <ExecutionDetail id={e.id} runOpen={run.status === 'open'} onChanged={() => { load(); onChanged(); }} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {run.executions.length === 0 && (
              <tr className="static">
                <td colSpan={5} className="muted empty">
                  No test cases in this run. Only approved test cases can be added.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function ExecutionPanel({ projectId }: { projectId: string }) {
  const { qaVersion } = useLive();
  const [runs, setRuns] = useState<QaRun[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', environment: '', build: '' });
  const m = useMsg();
  const load = useCallback(() => void api.runs(projectId).then(setRuns).catch(() => setRuns([])), [projectId]);
  useEffect(load, [load, qaVersion]);
  useEffect(() => setSel(null), [projectId]);
  const create = async () => {
    try {
      const r = await api.createRun(projectId, { ...form, addAllApproved: true });
      setForm({ name: '', environment: '', build: '' });
      setSel(r.id);
      m.ok(`${r.code} created with ${r.counts.total} approved test case(s).`);
      load();
    } catch (err) {
      m.fail(err);
    }
  };
  return (
    <div data-panel="execution">
      <section className="card">
        <h3>New test run</h3>
        <p className="hint">A run is one round of manual testing. It starts with every approved test case; drafts and rejected ones are never added.</p>
        <div className="row">
          <label>
            Name
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Sprint 12 regression" maxLength={120} data-run-name />
          </label>
          <label>
            Environment
            <input value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })} placeholder="staging" maxLength={120} />
          </label>
          <label>
            Build
            <input value={form.build} onChange={(e) => setForm({ ...form, build: e.target.value })} placeholder="1.0.3" maxLength={120} />
          </label>
          <button disabled={!form.name.trim()} onClick={() => void create()} data-create-run>
            Create run
          </button>
        </div>
        <MsgLine msg={m.msg} />
      </section>
      <section className="card">
        <h3>Runs</h3>
        <ul data-run-list>
          {runs.map((r) => (
            <li key={r.id}>
              <button className={sel === r.id ? 'tab on' : 'tab'} onClick={() => setSel(sel === r.id ? null : r.id)} data-run-open={r.code}>
                {r.code} · {r.name}
              </button>{' '}
              <span className="muted">
                {r.status} · {r.counts.passed}/{r.counts.total} passed
              </span>
            </li>
          ))}
          {runs.length === 0 && <li className="muted">No test runs yet.</li>}
        </ul>
      </section>
      {sel && <RunBoard runId={sel} onChanged={load} />}
    </div>
  );
}
