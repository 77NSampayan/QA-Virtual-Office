-- Pass 2B: manual test execution and evidence.
-- A PASSED result can only ever be recorded as made by a human (database constraint, not just code).
-- Execution history is append-only. Evidence FILES live in the data dir; only metadata is stored here.

CREATE TABLE test_runs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  seq         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT '',
  build       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_by  TEXT NOT NULL CHECK (created_by IN ('human','agent')),
  created_at  TEXT NOT NULL,
  closed_at   TEXT,
  UNIQUE (project_id, seq)
);
CREATE INDEX idx_test_runs_project ON test_runs(project_id, created_at);

CREATE TABLE test_executions (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  test_case_id   TEXT NOT NULL REFERENCES test_cases(id) ON DELETE RESTRICT,
  -- the test case version that was approved when it was added to the run
  case_version   INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'not_run' CHECK (status IN ('not_run','in_progress','passed','failed','blocked','skipped')),
  executor_kind  TEXT NOT NULL DEFAULT 'human' CHECK (executor_kind IN ('human','agent_assisted','automated')),
  executed_by    TEXT CHECK (executed_by IS NULL OR executed_by IN ('human','agent','system')),
  note           TEXT NOT NULL DEFAULT '',
  actual_result  TEXT NOT NULL DEFAULT '',
  started_at     TEXT,
  completed_at   TEXT,
  updated_at     TEXT NOT NULL,
  UNIQUE (run_id, test_case_id),
  -- only a person can record a pass
  -- (COALESCE: a NULL would make the check pass in SQLite)
  CHECK (status <> 'passed' OR COALESCE(executed_by, '') = 'human')
);
CREATE INDEX idx_exec_case ON test_executions(test_case_id, completed_at);
CREATE INDEX idx_exec_run ON test_executions(run_id);

CREATE TABLE execution_history (
  id           TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES test_executions(id) ON DELETE CASCADE,
  at           TEXT NOT NULL,
  actor        TEXT NOT NULL CHECK (actor IN ('human','agent','system')),
  action       TEXT NOT NULL,
  from_status  TEXT,
  to_status    TEXT,
  note         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_exec_hist ON execution_history(execution_id, at);
CREATE TRIGGER execution_history_no_update BEFORE UPDATE ON execution_history
BEGIN SELECT RAISE(ABORT, 'execution_history is append-only'); END;
CREATE TRIGGER execution_history_no_delete BEFORE DELETE ON execution_history
WHEN EXISTS (SELECT 1 FROM test_executions WHERE id = OLD.execution_id)
BEGIN SELECT RAISE(ABORT, 'execution_history is append-only'); END;

CREATE TABLE evidence (
  id           TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES test_executions(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('note','file')),
  label        TEXT NOT NULL DEFAULT '',
  -- notes: redacted text. files: nothing here (the file is on disk)
  body         TEXT NOT NULL DEFAULT '',
  file_name    TEXT,
  mime         TEXT,
  size_bytes   INTEGER,
  sha256       TEXT,
  stored_name  TEXT,
  redacted     INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT NOT NULL CHECK (created_by IN ('human','agent')),
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_evidence_exec ON evidence(execution_id);

-- Fix for 2A: its CHECK on test_cases let a NULL approver through (a NULL check result passes in SQLite).
-- A CHECK cannot be altered in place, so the rule is also enforced by triggers.
CREATE TRIGGER test_cases_approved_by_human_insert BEFORE INSERT ON test_cases
WHEN NEW.status = 'approved' AND (COALESCE(NEW.approved_by, '') <> 'human' OR NEW.approved_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'a test case can only be approved by a human'); END;
CREATE TRIGGER test_cases_approved_by_human_update BEFORE UPDATE ON test_cases
WHEN NEW.status = 'approved' AND (COALESCE(NEW.approved_by, '') <> 'human' OR NEW.approved_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'a test case can only be approved by a human'); END;
