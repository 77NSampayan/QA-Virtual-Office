import { useCallback, useEffect, useState } from 'react';
import { api, type AgentRun, type Playbook, type Project } from '../api.ts';
import { useLive } from '../live.tsx';
import { MsgLine, useMsg } from './qa/Requirements.tsx';

const AREA_TITLE: Record<Playbook['area'], string> = {
  requirements: 'Requirements',
  manual: 'Manual test cases',
  automation: 'Automation',
  api: 'API tests',
  defects: 'Defects',
  coordination: 'Coordination',
};
const KIND_LABEL: Record<Playbook['kind'], string> = { analyst: 'Analyst', writer: 'Writer', reviewer: 'Reviewer', investigator: 'Investigator', lead: 'Lead' };
const KIND_COLOR: Record<Playbook['kind'], string> = { analyst: '#6f7fe8', writer: '#3fbf9a', reviewer: '#ffd54a', investigator: '#ff9f43', lead: '#e2b93b' };

function PlaybookCard({ p, roleOf, onChanged, projects, onLaunched }: { p: Playbook; roleOf: (id: string | null) => string | null; onChanged: () => void; projects: Project[]; onLaunched: () => void }) {
  const [name, setName] = useState(p.agentName);
  const [projectId, setProjectId] = useState('');
  const [rules, setRules] = useState(p.houseRules);
  const m = useMsg();
  useEffect(() => (setName(p.agentName), setRules(p.houseRules)), [p.agentName, p.houseRules]);
  const dirty = name.trim() !== p.agentName || rules.trim() !== p.houseRules;
  return (
    <section className="card" data-playbook={p.id} data-agent-name={p.agentName} style={{ minWidth: 0 }}>
      <h3 style={{ marginTop: 0 }}>
        <span data-pb-title>{p.agentName}</span> <span className="muted">· {p.role}</span>{' '}
        <span className="pill" style={{ color: KIND_COLOR[p.kind] }} data-pb-kind={p.kind}>
          {KIND_LABEL[p.kind]}
        </span>{' '}
        {!p.available && <span className="pill soon">Arrives in Pass 3</span>}
      </h3>
      <p>{p.purpose}</p>
      {p.reviewedBy && (
        <p className="muted" data-pb-reviewer>
          Reviewed by: <strong>{roleOf(p.reviewedBy)}</strong>. An agent never reviews its own work.
        </p>
      )}
      <p className="muted" data-pb-tools style={{ overflowWrap: 'anywhere' }}>
        Can use: {p.tools.length ? p.tools.map((t) => <code key={t} style={{ marginRight: 6 }}>{t}</code>) : '—'}
        {p.plannedTools.length > 0 && (
          <>
            {' '}
            · coming with the review step: {p.plannedTools.map((t) => <code key={t} style={{ marginRight: 6 }}>{t}</code>)}
          </>
        )}
      </p>
      <details>
        <summary>Playbook steps</summary>
        <ol>
          {p.instructions.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ol>
      </details>
      <details>
        <summary>Review checklist</summary>
        <ul>
          {p.checklist.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      </details>
      <div className="project-form">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={30} aria-label={`Name of the ${p.role}`} data-pb-name />
        </label>
        <label>
          House rules (added to this agent’s instructions; they cannot give it more tools)
          <textarea rows={2} value={rules} onChange={(e) => setRules(e.target.value)} maxLength={2000} data-pb-rules />
        </label>
        <div className="row">
          <button
            disabled={!dirty}
            data-pb-save
            onClick={() =>
              void api
                .updatePlaybook(p.id, { agentName: name, houseRules: rules })
                .then(() => (m.ok('Saved.'), onChanged()))
                .catch(m.fail)
            }
          >
            Save
          </button>
          <button
            className="ghost"
            data-pb-reset
            disabled={p.agentName === p.defaultName && !p.houseRules}
            onClick={() =>
              void api
                .resetPlaybook(p.id)
                .then(() => (m.ok('Back to the default.'), onChanged()))
                .catch(m.fail)
            }
          >
            Reset to default
          </button>
        </div>
        <MsgLine msg={m.msg} />
      </div>
      {p.available && (
        <div className="row" data-pb-run-box>
          <label>
            Project
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} data-pb-project aria-label={`Project for ${p.agentName}`}>
              <option value="">Choose a project…</option>
              {projects
                .filter((x) => !x.archived)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.alias}
                  </option>
                ))}
            </select>
          </label>
          <button
            disabled={!projectId}
            data-pb-run
            onClick={() => {
              if (!confirm(`Open a terminal in this project's folder and start Claude Code as ${p.agentName} (${p.role})? ${p.agentName} can use only its own tools for this project, for 8 hours, and cannot approve anything.`)) return;
              void api
                .launchPlaybook(projectId, p.id)
                .then(() => (m.ok(`${p.agentName} was launched.`), onLaunched()))
                .catch(m.fail);
            }}
          >
            Run this playbook
          </button>
        </div>
      )}
    </section>
  );
}

/** Agents: the named working roles for Claude Code agents (playbooks). Rename them and add house rules; the tools are fixed. */
export function Agents() {
  const { qaVersion } = useLive();
  const [items, setItems] = useState<Playbook[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const m = useMsg();
  const load = useCallback(() => {
    void api.playbooks().then(setItems).catch(() => setItems([]));
    void api.projects().then(setProjects).catch(() => setProjects([]));
    void api.agentRuns().then(setRuns).catch(() => setRuns([]));
  }, []);
  useEffect(load, [load, qaVersion]);
  if (!items) return <div className="page muted">Loading…</div>;
  const nameOf = (id: string | null) => {
    const p = items.find((x) => x.id === id);
    return p ? `${p.agentName} (${p.role})` : null;
  };
  const areas = [...new Set(items.map((p) => p.area))];
  return (
    <div className="page" data-page="agents">
      <h2>Agents</h2>
      <p className="muted">
        Named working roles for the Claude Code agents you connect. Each has a fixed set of things it may do, a step-by-step playbook, and a checklist. <strong>Writers and reviewers are separate agents</strong>: a reviewer never reviews what it
        wrote. No agent can approve a test case, mark a test passed, close a defect or complete a task; only you can. Turn agent access on in Settings. <strong>Run this playbook</strong> opens Claude Code in the project as that agent: it can use only its own tools, for this one project, for 8 hours, and its robot in the office carries its name.
      </p>
      {areas.map((a) => (
        <div key={a} data-area={a}>
          <h3>{AREA_TITLE[a]}</h3>
          <div data-panel-grid style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))' }}>
            {items
              .filter((p) => p.area === a)
              .map((p) => (
                <PlaybookCard key={p.id} p={p} roleOf={nameOf} onChanged={load} projects={projects} onLaunched={load} />
              ))}
          </div>
        </div>
      ))}
      <h3>Recent runs</h3>
      <MsgLine msg={m.msg} />
      {runs.length === 0 ? (
        <p className="muted">No agent has been launched yet.</p>
      ) : (
        <div className="scroll-x">
          <table data-runs>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Project</th>
                <th>Started</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} data-run={r.id} data-run-status={r.status} style={{ cursor: 'default' }}>
                  <td>
                    {r.agentName} <span className="muted">({r.role})</span>
                  </td>
                  <td>{r.project ?? '—'}</td>
                  <td className="muted">{new Date(r.startedAt).toLocaleString()}</td>
                  <td>{r.status}</td>
                  <td>
                    {r.status === 'active' && (
                      <button className="ghost" data-run-stop onClick={() => void api.revokeRun(r.id).then(load).catch(m.fail)}>
                        Stop
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
