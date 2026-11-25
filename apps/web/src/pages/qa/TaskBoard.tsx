import { useCallback, useEffect, useState } from 'react';
import { DEFECT_PRIORITIES, TASK_KINDS, TASK_KIND_LABEL, TASK_STAGES, TASK_STAGE_LABEL, type TaskStage } from '@qavo/shared';
import { api, type QaTask, type QaTaskDetail } from '../../api.ts';
import { useLive } from '../../live.tsx';
import { MsgLine, useMsg } from './Requirements.tsx';

const PRIORITY_COLOR: Record<string, string> = { critical: '#ff5d6c', high: '#ff9f43', medium: '#ffd54a', low: '#9aa3b5' };

function TaskDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { qaVersion } = useLive();
  const [t, setT] = useState<QaTaskDetail | null>(null);
  const [note, setNote] = useState('');
  const [assignee, setAssignee] = useState('');
  const m = useMsg();
  const load = useCallback(
    () =>
      void api
        .task(id)
        .then((x) => {
          setT(x);
          setAssignee(x.assignee);
        })
        .catch(() => setT(null)),
    [id],
  );
  useEffect(load, [load, qaVersion]);
  if (!t) return <p className="muted loading" role="status">Loading…</p>;
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
  return (
    <div className="detail" data-task-detail={t.code}>
      <p>{t.description || <span className="muted">No description.</span>}</p>
      <p className="muted">
        {TASK_KIND_LABEL[t.kind as keyof typeof TASK_KIND_LABEL] ?? t.kind} · {t.priority}
        {t.dueDate ? ` · due ${t.dueDate}` : ''}
        {t.defectCode ? ` · ${t.defectCode}` : ''}
        {t.testCaseCode ? ` · ${t.testCaseCode}` : ''} · created by {t.createdBy}
      </p>
      <div className="project-form">
        <div className="row">
          <label>
            Assignee (you choose; nothing is assigned automatically)
            <input value={assignee} onChange={(e) => setAssignee(e.target.value)} maxLength={100} data-task-assignee />
          </label>
          <button className="ghost" disabled={assignee === t.assignee} onClick={() => void act(() => api.updateTask(id, { assignee }), 'Assignee saved.')}>
            Save assignee
          </button>
        </div>
        <label>
          Note (required to block a task or reopen a completed one)
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} data-task-note />
        </label>
        <div className="row">
          {TASK_STAGES.filter((s) => s !== t.stage).map((s) => (
            <button
              key={s}
              className={s === 'completed' ? '' : 'ghost'}
              data-move-to={s}
              disabled={(s === 'blocked' || t.stage === 'completed') && !note.trim()}
              onClick={() => void act(() => api.moveTask(id, s, note), `Moved to ${TASK_STAGE_LABEL[s]}.`)}
            >
              {TASK_STAGE_LABEL[s]}
            </button>
          ))}
        </div>
        <p className="hint">Only you can mark a task Completed.</p>
      </div>
      <MsgLine msg={m.msg} />
      <h4>History</h4>
      <ul className="muted">
        {t.history.map((h) => (
          <li key={h.id}>
            {new Date(h.at).toLocaleString()} · {h.actor} · {h.action}
            {h.toStage ? ` → ${TASK_STAGE_LABEL[h.toStage as TaskStage] ?? h.toStage}` : ''}
            {h.note ? ` — ${h.note}` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TaskBoardPanel({ projectId }: { projectId: string }) {
  const { qaVersion } = useLive();
  const [tasks, setTasks] = useState<QaTask[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState({ title: '', kind: 'other', priority: 'medium', assignee: '' });
  const m = useMsg();
  const load = useCallback(() => void api.tasks(projectId).then(setTasks).catch(() => setTasks([])), [projectId]);
  useEffect(load, [load, qaVersion]);
  useEffect(() => setOpen(null), [projectId]);
  const create = async () => {
    try {
      const t = await api.createTask(projectId, form);
      setForm({ title: '', kind: 'other', priority: 'medium', assignee: '' });
      setOpen(t.id);
      m.ok(`${t.code} added to the Backlog.`);
      load();
    } catch (err) {
      m.fail(err);
    }
  };
  return (
    <div data-panel="tasks">
      <section className="card">
        <h3>New task</h3>
        <div className="row">
          <label className="grow">
            Title
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={200} data-task-title />
          </label>
          <label>
            Type
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {TASK_KINDS.map((k) => (
                <option key={k} value={k}>
                  {TASK_KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Priority
            <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
              {DEFECT_PRIORITIES.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label>
            Assignee
            <input value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })} maxLength={100} placeholder="optional" />
          </label>
          <button disabled={!form.title.trim()} onClick={() => void create()} data-create-task>
            Add task
          </button>
        </div>
        <MsgLine msg={m.msg} />
      </section>
      <div className="board" data-board>
        {TASK_STAGES.map((stage) => {
          const col = tasks.filter((t) => t.stage === stage);
          return (
            <section className="card board-col" key={stage} data-stage={stage}>
              <h3>
                {TASK_STAGE_LABEL[stage]} <span className="muted">({col.length})</span>
              </h3>
              {col.length === 0 && <p className="muted">Empty</p>}
              {col.map((t) => (
                <button key={t.id} className={open === t.id ? 'task on' : 'task'} onClick={() => setOpen(open === t.id ? null : t.id)} data-task={t.code}>
                  <span className="mono">{t.code}</span> {t.title}
                  <span className="task-meta">
                    <span style={{ color: PRIORITY_COLOR[t.priority] }}>{t.priority}</span>
                    {t.assignee ? ` · ${t.assignee}` : ''}
                  </span>
                </button>
              ))}
            </section>
          );
        })}
      </div>
      {open && (
        <section className="card">
          <TaskDetail id={open} onChanged={load} />
        </section>
      )}
    </div>
  );
}
