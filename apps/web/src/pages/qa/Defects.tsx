import { Fragment, useCallback, useEffect, useState } from 'react';
import { DEFECT_PRIORITIES, DEFECT_STATUSES, DEFECT_STATUS_LABEL, SEVERITIES, nextDefectStatuses, type DefectStatus } from '@qavo/shared';
import { api, type QaDefect, type QaDefectDetail, type QaDefectInput } from '../../api.ts';
import { useLive } from '../../live.tsx';
import { MsgLine, useMsg } from './Requirements.tsx';

const STATUS_COLOR: Record<string, string> = {
  new: '#5ad1ff',
  open: '#ffd54a',
  in_progress: '#ff9f43',
  fixed: '#b9a3ff',
  retest: '#b9a3ff',
  reopened: '#ff5d6c',
  closed: '#4be37c',
  rejected: '#9aa3b5',
  duplicate: '#9aa3b5',
};
const SEV_COLOR: Record<string, string> = { critical: '#ff5d6c', major: '#ff9f43', minor: '#ffd54a', trivial: '#9aa3b5' };
const NOTE_NEEDED = ['rejected', 'duplicate', 'reopened', 'closed'];

export const DefectBadge = ({ status }: { status: string }) => (
  <span className="pill" style={{ color: STATUS_COLOR[status] ?? '#9aa3b5' }} data-defect-status={status}>
    {DEFECT_STATUS_LABEL[status as DefectStatus] ?? status}
  </span>
);
export const SeverityBadge = ({ severity }: { severity: string }) => (
  <span className="pill" style={{ color: SEV_COLOR[severity] ?? '#9aa3b5' }}>
    {severity}
  </span>
);

const EMPTY: Required<QaDefectInput> = { title: '', description: '', steps: '', expectedResult: '', actualResult: '', environment: '', build: '', severity: 'major', priority: 'medium', assignee: '' };

export function DefectForm({ initial, onSubmit, onCancel, submitLabel }: { initial?: Partial<QaDefectInput>; onSubmit: (b: QaDefectInput) => Promise<void>; onCancel: () => void; submitLabel: string }) {
  const [f, setF] = useState<Required<QaDefectInput>>({ ...EMPTY, ...initial });
  const set = (k: keyof QaDefectInput, v: string) => setF((p) => ({ ...p, [k]: v }));
  return (
    <form
      className="project-form"
      data-defect-form
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(f);
      }}
    >
      <label>
        Title
        <input value={f.title} onChange={(e) => set('title', e.target.value)} maxLength={200} required data-field="title" />
      </label>
      <div className="row">
        <label>
          Severity
          <select value={f.severity} onChange={(e) => set('severity', e.target.value)}>
            {SEVERITIES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Priority
          <select value={f.priority} onChange={(e) => set('priority', e.target.value)}>
            {DEFECT_PRIORITIES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Environment
          <input value={f.environment} onChange={(e) => set('environment', e.target.value)} maxLength={120} />
        </label>
        <label>
          Build
          <input value={f.build} onChange={(e) => set('build', e.target.value)} maxLength={120} />
        </label>
        <label>
          Assignee
          <input value={f.assignee} onChange={(e) => set('assignee', e.target.value)} maxLength={100} />
        </label>
      </div>
      <label>
        Steps to reproduce
        <textarea rows={3} value={f.steps} onChange={(e) => set('steps', e.target.value)} maxLength={10000} />
      </label>
      <label>
        Expected result
        <textarea rows={2} value={f.expectedResult} onChange={(e) => set('expectedResult', e.target.value)} maxLength={5000} />
      </label>
      <label>
        Actual result
        <textarea rows={2} value={f.actualResult} onChange={(e) => set('actualResult', e.target.value)} maxLength={5000} data-field="actualResult" />
      </label>
      <label>
        Description (use fake or masked data, never real customer data)
        <textarea rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={10000} />
      </label>
      <div className="row">
        <button>{submitLabel}</button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function DefectDetail({ id, others, onChanged }: { id: string; others: QaDefect[]; onChanged: () => void }) {
  const { qaVersion } = useLive();
  const [d, setD] = useState<QaDefectDetail | null>(null);
  const [edit, setEdit] = useState(false);
  const [note, setNote] = useState('');
  const [dupOf, setDupOf] = useState('');
  const m = useMsg();
  const load = useCallback(() => void api.defect(id).then(setD).catch(() => setD(null)), [id]);
  useEffect(load, [load, qaVersion]);
  if (!d) return <p className="muted">Loading…</p>;
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      m.ok(ok);
      setNote('');
      load();
      onChanged();
    } catch (err) {
      m.fail(err);
    }
  };
  const next = nextDefectStatuses(d.status as DefectStatus);
  const finished = ['closed', 'rejected', 'duplicate'].includes(d.status);
  return (
    <div className="detail" data-defect-detail={d.code}>
      <dl className="fields">
        <dt>Reported by</dt>
        <dd>{d.reportedBy}</dd>
        <dt>Links</dt>
        <dd>
          {d.testCaseCode ? `Test case ${d.testCaseCode}` : '—'}
          {d.runCode ? ` · ${d.runCode}` : ''}
          {d.duplicateOfCode ? ` · duplicate of ${d.duplicateOfCode}` : ''}
        </dd>
        <dt>Environment</dt>
        <dd>
          {d.environment || '—'} {d.build ? `· build ${d.build}` : ''}
        </dd>
        <dt>Assignee</dt>
        <dd>{d.assignee || '—'}</dd>
        <dt>Steps</dt>
        <dd style={{ whiteSpace: 'pre-wrap' }}>{d.steps || '—'}</dd>
        <dt>Expected</dt>
        <dd>{d.expectedResult || '—'}</dd>
        <dt>Actual</dt>
        <dd>{d.actualResult || '—'}</dd>
        {d.description && (
          <>
            <dt>Description</dt>
            <dd style={{ whiteSpace: 'pre-wrap' }}>{d.description}</dd>
          </>
        )}
      </dl>
      {edit ? (
        <DefectForm
          initial={d}
          submitLabel="Save changes"
          onCancel={() => setEdit(false)}
          onSubmit={async (b) => {
            const { title, description, steps, expectedResult, actualResult, environment, build, severity, priority, assignee } = b;
            await act(() => api.updateDefect(id, { title, description, steps, expectedResult, actualResult, environment, build, severity, priority, assignee }), 'Saved.');
            setEdit(false);
          }}
        />
      ) : (
        !finished && (
          <button className="ghost" onClick={() => setEdit(true)}>
            Edit
          </button>
        )
      )}

      <h4>Status</h4>
      <div className="project-form" data-defect-actions>
        <label>
          Note (required for Rejected, Duplicate, Reopened and Closed)
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={5000} data-defect-note />
        </label>
        {next.includes('duplicate') && (
          <label>
            Duplicate of
            <select value={dupOf} onChange={(e) => setDupOf(e.target.value)} data-dup-of>
              <option value="">Choose a defect…</option>
              {others
                .filter((o) => o.id !== id)
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.code} {o.title}
                  </option>
                ))}
            </select>
          </label>
        )}
        <div className="row">
          {next.map((to) => (
            <button
              key={to}
              className={to === 'closed' ? '' : 'ghost'}
              data-defect-to={to}
              disabled={(NOTE_NEEDED.includes(to) && !note.trim()) || (to === 'duplicate' && !dupOf)}
              onClick={() => void act(() => api.transitionDefect(id, { to, note, ...(to === 'duplicate' ? { duplicateOfId: dupOf } : {}) }), `Marked ${DEFECT_STATUS_LABEL[to].toLowerCase()}.`)}
            >
              {DEFECT_STATUS_LABEL[to]}
            </button>
          ))}
          <button className="ghost" disabled={!note.trim()} onClick={() => void act(() => api.commentDefect(id, note), 'Comment added.')}>
            Add comment
          </button>
        </div>
        <p className="hint">Only you can change a defect&apos;s status. Agents can report defects and comment, never close them.</p>
      </div>
      <MsgLine msg={m.msg} />
      <h4>History</h4>
      <ul className="muted">
        {d.history.map((h) => (
          <li key={h.id}>
            {new Date(h.at).toLocaleString()} · {h.actor} · {h.action}
            {h.toStatus ? ` → ${DEFECT_STATUS_LABEL[h.toStatus as DefectStatus] ?? h.toStatus}` : ''}
            {h.note ? ` — ${h.note}` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DefectsPanel({ projectId }: { projectId: string }) {
  const { qaVersion } = useLive();
  const [items, setItems] = useState<QaDefect[]>([]);
  const [filter, setFilter] = useState({ status: '', severity: '', q: '', openOnly: false });
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const m = useMsg();
  const load = useCallback(
    () => void api.defects(projectId, { status: filter.status, severity: filter.severity, q: filter.q, openOnly: filter.openOnly ? 'true' : '' }).then(setItems).catch(() => setItems([])),
    [projectId, filter],
  );
  useEffect(load, [load, qaVersion]);
  return (
    <div data-panel="defects">
      <div className="row toolbar">
        <button onClick={() => setAdding(!adding)} data-new-defect>
          {adding ? 'Close form' : 'Report defect'}
        </button>
        <input placeholder="Search…" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} aria-label="Search defects" />
        <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })} aria-label="Status filter">
          <option value="">All statuses</option>
          {DEFECT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {DEFECT_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <select value={filter.severity} onChange={(e) => setFilter({ ...filter, severity: e.target.value })} aria-label="Severity filter">
          <option value="">All severities</option>
          {SEVERITIES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={filter.openOnly} onChange={(e) => setFilter({ ...filter, openOnly: e.target.checked })} />
          <span>Open only</span>
        </label>
        <span className="muted">{items.length} defect(s)</span>
      </div>
      {adding && (
        <section className="card">
          <DefectForm
            submitLabel="Report defect"
            onCancel={() => setAdding(false)}
            onSubmit={async (b) => {
              try {
                const d = await api.createDefect(projectId, b);
                setAdding(false);
                m.ok(`${d.code} reported.`);
                load();
              } catch (err) {
                m.fail(err);
              }
            }}
          />
        </section>
      )}
      <MsgLine msg={m.msg} />
      <section className="card">
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Title</th>
                <th>Severity</th>
                <th>Priority</th>
                <th>Status</th>
                <th>Linked to</th>
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <Fragment key={d.id}>
                  <tr className={open === d.id ? 'selected' : ''} data-defect={d.code} onClick={() => setOpen(open === d.id ? null : d.id)}>
                    <td className="mono">{d.code}</td>
                    <td>
                      {d.title}
                      {d.reportedBy === 'agent' && <span className="pill soon"> agent</span>}
                    </td>
                    <td>
                      <SeverityBadge severity={d.severity} />
                    </td>
                    <td>{d.priority}</td>
                    <td>
                      <DefectBadge status={d.status} />
                    </td>
                    <td className="muted">{[d.testCaseCode, d.runCode].filter(Boolean).join(' · ') || '—'}</td>
                  </tr>
                  {open === d.id && (
                    <tr style={{ cursor: 'default' }}>
                      <td colSpan={6}>
                        <DefectDetail id={d.id} others={items} onChanged={load} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {items.length === 0 && (
                <tr style={{ cursor: 'default' }}>
                  <td colSpan={6} className="muted">
                    No defects. Report one here, raise it from a failed test in Execution, or from a bug note in an exploratory session.
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
