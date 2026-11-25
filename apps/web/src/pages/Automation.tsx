import { useCallback, useEffect, useState } from 'react';
import { AUTOMATION_CLASSIFICATIONS, AUTOMATION_CLASSIFICATION_LABEL, type AutomationClassification } from '@qavo/shared';
import { api, type AutomationScript, type AutomationImportResult, type FrameworkDetection, type AutomationResult, type AutomationRun, type AutomationRunDetail } from '../api.ts';
import { useLive } from '../live.tsx';
import { Drawer } from '../ui.tsx';
import { ScriptDetail, ScriptsPanel } from './ScriptsPanel.tsx';
import { MsgLine, useMsg } from './qa/Requirements.tsx';

const KEY = 'qavo.automation.project';
const readSaved = () => {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
};
const MAX_BYTES = 5 * 1024 * 1024;

const rate = (r: { numerator: number; denominator: number; percent: number | null }) => (r.percent === null ? 'No data (nothing was counted)' : `${r.percent}% (${r.numerator} of ${r.denominator})`);
const secs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const STATUS_CLASS: Record<AutomationResult['status'], string> = { passed: 'ok-text', failed: 'warn-text', error: 'warn-text', skipped: 'muted' };

const CONFIDENCE_LABEL = { config: 'Config file found', dependency: 'Declared as a dependency', files: 'Matching test files only' } as const;

/** Read-only scan of the registered project's folder: which test frameworks it uses. Names and versions only; nothing is stored. */
function DetectPanel({ projectId }: { projectId: string }) {
  const [res, setRes] = useState<FrameworkDetection | null>(null);
  const [busy, setBusy] = useState(false);
  const m = useMsg();
  useEffect(() => (setRes(null), m.clear()), [projectId]);
  return (
    <section className="card project-form" data-auto-detect>
      <h3>Test frameworks in this project</h3>
      <p className="hint">
        Press <strong>Scan project</strong> to look in the project folder (up to three folders deep) for test framework config files and dependency lists: Playwright, Cypress, Selenium, WebdriverIO, TestCafe, Jest, Vitest, Mocha, pytest, Robot Framework, JUnit and TestNG. It
        reads <strong>file names and a few small dependency lists</strong> (package.json, requirements, pyproject.toml, pom.xml, build.gradle). It never reads your source code or test files, never changes anything and keeps nothing: the answer is shown here and forgotten.
      </p>
      <div className="row">
        <button
          disabled={busy}
          data-auto-detect-btn
          onClick={() => {
            setBusy(true);
            m.clear();
            void api
              .detectFrameworks(projectId)
              .then(setRes)
              .catch((e) => (setRes(null), m.fail(e)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Scanning…' : res ? 'Scan again' : 'Scan project'}
        </button>
      </div>
      <MsgLine msg={m.msg} />
      {res && (
        <div data-auto-detect-result>
          <p className="muted" data-auto-detect-scanned>
            Looked at {res.scanned.files} file name(s) in {res.scanned.folders} folder(s); read {res.scanned.manifestsRead} dependency list(s).
          </p>
          {res.notes.map((n) => (
            <p key={n} className="hint">
              {n}
            </p>
          ))}
          {res.frameworks.map((f) => (
            <div key={f.id} className="plan quiet" data-framework={f.id} data-framework-confidence={f.confidence}>
              <p>
                <strong>{f.label}</strong> <span className="muted">· {f.language}</span> <span className="pill">{CONFIDENCE_LABEL[f.confidence]}</span>
              </p>
              <ul>
                {f.evidence.map((e, i) => (
                  <li key={i}>
                    {e.kind === 'config_file' ? 'Config file' : e.kind === 'dependency' ? 'Dependency in' : 'Found'} <code>{e.file}</code> ({e.where}){e.detail && <> · {e.detail}</>}
                  </li>
                ))}
              </ul>
              <p className="muted">To import its results: {f.exportHint}.</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ImportPanel({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState('');
  const [preview, setPreview] = useState<AutomationImportResult | null>(null);
  const m = useMsg();
  const run = async (dryRun: boolean) => {
    try {
      const r = await api.importAutomation(projectId, { text, name, environment, dryRun });
      if (dryRun) {
        setPreview(r);
        m.clear();
      } else {
        setPreview(null);
        setText('');
        setFileName('');
        setName('');
        m.ok(`Imported as ${r.created?.code}. Failed tests are "unknown" until you classify them.`);
        onDone();
      }
    } catch (err) {
      setPreview(null);
      m.fail(err);
    }
  };
  const readFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_BYTES) return m.fail(new Error('That file is larger than 5 MB.'));
    setText(await file.text());
    setFileName(file.name);
    setPreview(null);
    m.clear();
  };
  return (
    <section className="card project-form" data-auto-import>
      <h3>Import results</h3>
      <p className="hint">
        Import a <strong>JUnit XML</strong> file. pytest, Robot Framework, Playwright, Jest (jest-junit), Maven and most CI tools can export this format. Only <strong>test names, status, duration and the first line of a failure message</strong> are kept (redacted).
        Stack traces, logs, screenshots and attachments are dropped. Imported results never change a manual test case or its status.
      </p>
      <div className="row">
        <label>
          JUnit XML file
          <input type="file" accept=".xml,text/xml,application/xml" data-auto-file onChange={(e) => void readFile(e.target.files?.[0])} />
        </label>
        <label>
          Name (optional)
          <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Nightly regression" data-auto-name />
        </label>
        <label>
          Environment (optional)
          <input value={environment} maxLength={80} onChange={(e) => setEnvironment(e.target.value)} placeholder="staging" data-auto-env />
        </label>
      </div>
      <label>
        Or paste the XML
        <textarea rows={4} value={text} data-auto-text onChange={(e) => (setText(e.target.value), setPreview(null), setFileName(''))} maxLength={MAX_BYTES} placeholder={'<testsuite name="…"><testcase classname="…" name="…"/></testsuite>'} />
      </label>
      <div className="row">
        <button className="ghost" disabled={!text.trim()} data-auto-preview-btn onClick={() => void run(true)}>
          Preview
        </button>
        <button disabled={!preview || !!preview.alreadyImported || preview.total === 0} data-auto-run onClick={() => void run(false)}>
          Import {preview ? preview.total : ''} result(s)
        </button>
        {fileName && <span className="muted">Loaded: {fileName}</span>}
      </div>
      {preview && (
        <div className="plan" data-auto-preview>
          <p data-auto-summary>
            <strong>{preview.total}</strong> test result(s): {preview.counts.passed} passed, {preview.counts.failed} failed, {preview.counts.errored} errored, {preview.counts.skipped} skipped.
            Pass rate = passed ÷ (passed + failed + errored), skipped not counted: <strong>{rate(preview.passRate)}</strong>.
            {preview.linked > 0 && <> {preview.linked} result(s) mention a test case ID and will be shown next to it.</>}
            {preview.truncated && <> Only the first 20,000 were read.</>}
          </p>
          {preview.alreadyImported && (
            <p className="error" data-auto-duplicate>
              This exact file was already imported as {preview.alreadyImported}.
            </p>
          )}
          {preview.problems.length > 0 && (
            <ul>
              {preview.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <MsgLine msg={m.msg} />
    </section>
  );
}

function RunDetail({ id, onChanged, onDeleted }: { id: string; onChanged: () => void; onDeleted: () => void }) {
  const [d, setD] = useState<AutomationRunDetail | null>(null);
  const [filter, setFilter] = useState<'all' | 'failures' | 'unclassified'>('failures');
  const m = useMsg();
  const load = useCallback(() => void api.automationRun(id).then(setD).catch(m.fail), [id]);
  useEffect(load, [load]);
  if (!d) return <p className="muted loading" role="status">Loading…</p>;
  const shown = d.results.filter((r) => (filter === 'all' ? true : filter === 'failures' ? r.status === 'failed' || r.status === 'error' : (r.status === 'failed' || r.status === 'error') && r.classification === 'unknown'));
  return (
    <div className="detail" data-auto-detail={d.code}>
      <p>
        <strong>{d.name}</strong> {d.environment && <span className="muted">· {d.environment}</span>}
      </p>
      <p className="muted" data-auto-formula>
        {d.counts.passed} passed, {d.counts.failed} failed, {d.counts.errored} errored, {d.counts.skipped} skipped · total time {secs(d.durationMs)}.
        Pass rate = passed ÷ (passed + failed + errored): <strong>{rate(d.passRate)}</strong>. Skipped tests are not counted.
      </p>
      <div className="row">
        <label>
          Show
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} data-auto-filter>
            <option value="failures">Failed and errored</option>
            <option value="unclassified">Not yet classified</option>
            <option value="all">All results</option>
          </select>
        </label>
        <span className="muted">{shown.length} shown</span>
      </div>
      <p className="hint">A failure stays “Unknown” until you classify it; nothing is guessed. Classifying is only a label: it does not change any test case or defect.</p>
      <div className="scroll-x">
        <table data-auto-results>
          <thead>
            <tr>
              <th>Test</th>
              <th>Status</th>
              <th>Classification</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className="static" data-auto-result={r.status}>
                <td>
                  {r.name}
                  <div className="muted">
                    {[r.suite, r.className].filter(Boolean).join(' › ')} · {secs(r.durationMs)}
                    {r.testCaseCode && <> · mentions <span className="mono" data-auto-linked>{r.testCaseCode}</span></>}
                  </div>
                  {r.message && <div className="muted prewrap">{r.message}</div>}
                </td>
                <td className={STATUS_CLASS[r.status]}>{r.status}</td>
                <td>
                  {r.status === 'failed' || r.status === 'error' ? (
                    <select
                      value={r.classification}
                      aria-label={`Classification of ${r.name}`}
                      data-auto-classify
                      onChange={(e) =>
                        void api
                          .classifyAutomation(r.id, e.target.value as AutomationClassification)
                          .then(() => (load(), onChanged()))
                          .catch(m.fail)
                      }
                    >
                      {AUTOMATION_CLASSIFICATIONS.map((c) => (
                        <option key={c} value={c}>
                          {AUTOMATION_CLASSIFICATION_LABEL[c]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr className="static">
                <td colSpan={3} className="muted empty">
                  Nothing to show for this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <MsgLine msg={m.msg} />
      <div className="row">
        <button
          className="danger"
          data-auto-delete
          onClick={() => {
            if (!confirm(`Delete ${d.code} and its ${d.counts.total} imported results? The file itself is not affected.`)) return;
            void api.deleteAutomationRun(d.id).then(onDeleted).catch(m.fail);
          }}
        >
          Delete this import
        </button>
      </div>
    </div>
  );
}

/** Test Automation Department (Pass 3, A1): import JUnit XML results, see pass rates with their denominators, classify failures. */
export function Automation() {
  const { projects, qaVersion } = useLive();
  const active = projects.filter((p) => !p.archived);
  const [pid, setPid] = useState(readSaved);
  const current = active.find((p) => p.id === pid) ?? active[0];
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [openScript, setOpenScript] = useState<string | null>(null);
  const [scripts, setScripts] = useState<AutomationScript[] | null>(null);
  const currentId = current?.id;
  const load = useCallback(() => {
    if (!currentId) return;
    void api.automationRuns(currentId).then(setRuns).catch(() => setRuns([]));
    void api.automationScripts(currentId).then(setScripts).catch(() => setScripts([]));
  }, [currentId]);
  useEffect(load, [load, qaVersion]);
  useEffect(() => (setOpen(null), setOpenScript(null)), [currentId]);
  useEffect(() => {
    try {
      if (currentId) localStorage.setItem(KEY, currentId);
    } catch {
      /* storage unavailable: fine */
    }
  }, [currentId]);

  return (
    <div className="page" data-page="automation">
      <h2>Test Automation Department</h2>
      {!current ? (
        <section className="card">
          <p>
            Register a project first (<a href="#/projects">Project Rooms</a>): automation results belong to a project.
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
          <DetectPanel projectId={current.id} />
          <ImportPanel projectId={current.id} onDone={load} />
          <section className="card">
            <h3>Imported runs</h3>
            {runs === null ? (
              <p className="muted loading" role="status">Loading…</p>
            ) : (
              <div className="scroll-x">
                <table data-auto-runs>
                  <thead>
                    <tr>
                      <th>Run</th>
                      <th>Name</th>
                      <th>Imported</th>
                      <th>Passed</th>
                      <th>Failed</th>
                      <th>Skipped</th>
                      <th>Pass rate</th>
                      <th>Unclassified</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => (
                      <tr key={r.id} className={open === r.id ? 'selected' : ''} data-auto-run-row={r.code} onClick={() => (setOpenScript(null), setOpen(open === r.id ? null : r.id))}>
                        <td className="mono">{r.code}</td>
                        <td>
                          {r.name}
                          {r.environment && <span className="muted"> · {r.environment}</span>}
                        </td>
                        <td className="muted">{new Date(r.importedAt).toLocaleString()}</td>
                        <td>{r.counts.passed}</td>
                        <td>{r.counts.failed + r.counts.errored}</td>
                        <td className="muted">{r.counts.skipped}</td>
                        <td data-auto-rate title="passed ÷ (passed + failed + errored); skipped not counted">{rate(r.passRate)}</td>
                        <td>{r.unclassifiedFailures > 0 ? <span className="pill warn-text">{r.unclassifiedFailures}</span> : <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                    {runs.length === 0 && (
                      <tr className="static">
                        <td colSpan={8} className="muted empty">
                          No results imported yet. Import a JUnit XML file above.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <ScriptsPanel scripts={scripts} open={openScript} onOpen={(id) => (setOpen(null), setOpenScript(id))} />
          {openScript && (
            <Drawer title={scripts?.find((x) => x.id === openScript)?.code ?? 'Script'} onClose={() => setOpenScript(null)}>
              <ScriptDetail id={openScript} onChanged={load} />
            </Drawer>
          )}
          {open && (
            <Drawer title={runs?.find((r) => r.id === open)?.code ?? 'Run'} onClose={() => setOpen(null)}>
              <RunDetail id={open} onChanged={load} onDeleted={() => (setOpen(null), load())} />
            </Drawer>
          )}
        </>
      )}
    </div>
  );
}
