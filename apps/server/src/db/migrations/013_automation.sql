-- Pass 3 (A1): imported automation results. Metadata only: suite, test name, status, duration and a short redacted
-- first line of the failure message. Stack traces, logs and attachments are never stored.
-- A failed test is "unknown" until a PERSON classifies it. Nothing here can change a manual test case.
CREATE TABLE automation_runs (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  seq          INTEGER NOT NULL,
  name         TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'junit' CHECK (source IN ('junit')),
  environment  TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  total        INTEGER NOT NULL,
  passed       INTEGER NOT NULL,
  failed       INTEGER NOT NULL,
  errored      INTEGER NOT NULL,
  skipped      INTEGER NOT NULL,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  imported_at  TEXT NOT NULL,
  UNIQUE (project_id, seq),
  UNIQUE (project_id, content_hash)
);
CREATE INDEX idx_automation_runs_project ON automation_runs(project_id, imported_at);

CREATE TABLE automation_results (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
  suite          TEXT NOT NULL DEFAULT '',
  class_name     TEXT NOT NULL DEFAULT '',
  name           TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('passed','failed','error','skipped')),
  duration_ms    INTEGER NOT NULL DEFAULT 0,
  message        TEXT NOT NULL DEFAULT '',
  classification TEXT NOT NULL DEFAULT 'unknown' CHECK (classification IN ('unknown','product_defect','test_issue','environment','flaky')),
  classified_at  TEXT,
  test_case_id   TEXT REFERENCES test_cases(id) ON DELETE SET NULL
);
CREATE INDEX idx_automation_results_run ON automation_results(run_id, status);
CREATE INDEX idx_automation_results_case ON automation_results(test_case_id);
