-- Pass 2C: defects, exploratory testing sessions, task board.
-- CLOSED / REJECTED / DUPLICATE defects can only be recorded as made by a human (CHECK, written with
-- COALESCE because a NULL check result passes in SQLite). Histories are append-only.

CREATE TABLE defects (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  seq              INTEGER NOT NULL,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  steps            TEXT NOT NULL DEFAULT '',
  expected_result  TEXT NOT NULL DEFAULT '',
  actual_result    TEXT NOT NULL DEFAULT '',
  environment      TEXT NOT NULL DEFAULT '',
  build            TEXT NOT NULL DEFAULT '',
  severity         TEXT NOT NULL DEFAULT 'major' CHECK (severity IN ('critical','major','minor','trivial')),
  priority         TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('critical','high','medium','low')),
  status           TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','open','in_progress','fixed','retest','reopened','closed','rejected','duplicate')),
  assignee         TEXT NOT NULL DEFAULT '',
  test_case_id     TEXT REFERENCES test_cases(id) ON DELETE SET NULL,
  execution_id     TEXT REFERENCES test_executions(id) ON DELETE SET NULL,
  duplicate_of_id  TEXT REFERENCES defects(id) ON DELETE SET NULL,
  reported_by      TEXT NOT NULL CHECK (reported_by IN ('human','agent')),
  closed_by        TEXT CHECK (closed_by IS NULL OR closed_by IN ('human','agent','system')),
  closed_at        TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (project_id, seq),
  CHECK (status NOT IN ('closed','rejected','duplicate') OR (COALESCE(closed_by, '') = 'human' AND closed_at IS NOT NULL))
);
CREATE INDEX idx_defects_project ON defects(project_id, status);
CREATE INDEX idx_defects_execution ON defects(execution_id);
CREATE INDEX idx_defects_case ON defects(test_case_id);

CREATE TABLE defect_history (
  id          TEXT PRIMARY KEY,
  defect_id   TEXT NOT NULL REFERENCES defects(id) ON DELETE CASCADE,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL CHECK (actor IN ('human','agent','system')),
  action      TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  note        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_defect_hist ON defect_history(defect_id, at);
CREATE TRIGGER defect_history_no_update BEFORE UPDATE ON defect_history
BEGIN SELECT RAISE(ABORT, 'defect_history is append-only'); END;
CREATE TRIGGER defect_history_no_delete BEFORE DELETE ON defect_history
WHEN EXISTS (SELECT 1 FROM defects WHERE id = OLD.defect_id)
BEGIN SELECT RAISE(ABORT, 'defect_history is append-only'); END;

CREATE TABLE exploratory_sessions (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  seq              INTEGER NOT NULL,
  charter          TEXT NOT NULL,
  area             TEXT NOT NULL DEFAULT '',
  tester           TEXT NOT NULL DEFAULT '',
  timebox_minutes  INTEGER NOT NULL DEFAULT 60 CHECK (timebox_minutes BETWEEN 5 AND 480),
  status           TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_progress','completed')),
  summary          TEXT NOT NULL DEFAULT '',
  created_by       TEXT NOT NULL CHECK (created_by IN ('human','agent')),
  created_at       TEXT NOT NULL,
  started_at       TEXT,
  ended_at         TEXT,
  UNIQUE (project_id, seq)
);
CREATE INDEX idx_explore_project ON exploratory_sessions(project_id, created_at);

CREATE TABLE exploratory_notes (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES exploratory_sessions(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('note','bug','question','idea')),
  text        TEXT NOT NULL,
  defect_id   TEXT REFERENCES defects(id) ON DELETE SET NULL,
  created_by  TEXT NOT NULL CHECK (created_by IN ('human','agent')),
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_explore_notes ON exploratory_notes(session_id, created_at);

CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  seq           INTEGER NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('test_design','execution','retest','review','defect_followup','other')),
  priority      TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('critical','high','medium','low')),
  stage         TEXT NOT NULL DEFAULT 'backlog' CHECK (stage IN ('backlog','ready','in_progress','waiting_review','blocked','completed')),
  -- assignment is always a deliberate choice (a name or role); nothing is auto-assigned
  assignee      TEXT NOT NULL DEFAULT '',
  due_date      TEXT,
  defect_id     TEXT REFERENCES defects(id) ON DELETE SET NULL,
  test_case_id  TEXT REFERENCES test_cases(id) ON DELETE SET NULL,
  created_by    TEXT NOT NULL CHECK (created_by IN ('human','agent')),
  completed_by  TEXT CHECK (completed_by IS NULL OR completed_by IN ('human','agent','system')),
  completed_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (project_id, seq),
  -- only a person marks a task completed
  CHECK (stage <> 'completed' OR (COALESCE(completed_by, '') = 'human' AND completed_at IS NOT NULL))
);
CREATE INDEX idx_tasks_project ON tasks(project_id, stage);

CREATE TABLE task_history (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL CHECK (actor IN ('human','agent','system')),
  action     TEXT NOT NULL,
  from_stage TEXT,
  to_stage   TEXT,
  note       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_task_hist ON task_history(task_id, at);
CREATE TRIGGER task_history_no_update BEFORE UPDATE ON task_history
BEGIN SELECT RAISE(ABORT, 'task_history is append-only'); END;
CREATE TRIGGER task_history_no_delete BEFORE DELETE ON task_history
WHEN EXISTS (SELECT 1 FROM tasks WHERE id = OLD.task_id)
BEGIN SELECT RAISE(ABORT, 'task_history is append-only'); END;
