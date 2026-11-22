-- Pass 2A: Manual QA (requirements and test cases).
-- Project foreign keys are RESTRICT: a project that holds QA records cannot be deleted by accident
-- (archive it instead). History tables are append-only, enforced by triggers.

CREATE TABLE requirements (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  ref           TEXT NOT NULL,
  title         TEXT NOT NULL,
  text          TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('brd','fsd','user_story','acceptance_criteria','other')),
  review_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed','reviewed','needs_clarification')),
  authored_by   TEXT NOT NULL CHECK (authored_by IN ('human','agent')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (project_id, ref)
);
CREATE INDEX idx_requirements_project ON requirements(project_id);

CREATE TABLE requirement_flags (
  id                     TEXT PRIMARY KEY,
  requirement_id         TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  type                   TEXT NOT NULL CHECK (type IN ('ambiguity','gap','conflict','other')),
  note                   TEXT NOT NULL,
  related_requirement_id TEXT REFERENCES requirements(id) ON DELETE SET NULL,
  raised_by              TEXT NOT NULL CHECK (raised_by IN ('human','agent','system')),
  -- stable key of an automatic hint, so a dismissed hint is never raised again
  marker                 TEXT,
  status                 TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  created_at             TEXT NOT NULL,
  resolved_at            TEXT,
  resolved_note          TEXT
);
CREATE INDEX idx_flags_requirement ON requirement_flags(requirement_id);
CREATE UNIQUE INDEX idx_flags_marker ON requirement_flags(requirement_id, marker) WHERE marker IS NOT NULL;

CREATE TABLE test_cases (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  seq             INTEGER NOT NULL,
  code            TEXT NOT NULL,
  scenario        TEXT NOT NULL DEFAULT '',
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  preconditions   TEXT NOT NULL DEFAULT '',
  steps_json      TEXT NOT NULL DEFAULT '[]',
  test_data       TEXT NOT NULL DEFAULT '',
  expected_result TEXT NOT NULL DEFAULT '',
  priority        TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('critical','high','medium','low')),
  test_type       TEXT NOT NULL DEFAULT 'positive' CHECK (test_type IN
    ('positive','negative','boundary_value','equivalence_partitioning','decision_table','state_transition','exploratory','regression','integration','end_to_end')),
  assigned_tester TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','approved','rejected')),
  authored_by     TEXT NOT NULL CHECK (authored_by IN ('human','agent')),
  approved_by     TEXT CHECK (approved_by IS NULL OR approved_by = 'human'),
  approved_at     TEXT,
  rejection_note  TEXT NOT NULL DEFAULT '',
  version         INTEGER NOT NULL DEFAULT 1,
  archived        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (project_id, seq),
  UNIQUE (project_id, code),
  -- an approval can only ever be recorded as made by a human
  CHECK (status <> 'approved' OR (approved_by = 'human' AND approved_at IS NOT NULL))
);
CREATE INDEX idx_test_cases_project ON test_cases(project_id, status);

CREATE TABLE test_case_requirements (
  test_case_id   TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  PRIMARY KEY (test_case_id, requirement_id)
);
CREATE INDEX idx_tcr_requirement ON test_case_requirements(requirement_id);

CREATE TABLE test_case_history (
  id           TEXT PRIMARY KEY,
  test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  at           TEXT NOT NULL,
  actor        TEXT NOT NULL CHECK (actor IN ('human','agent','system')),
  action       TEXT NOT NULL,
  from_status  TEXT,
  to_status    TEXT,
  note         TEXT NOT NULL DEFAULT '',
  changes_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_tch_case ON test_case_history(test_case_id, at);

-- Append-only: history rows can never be edited, and cannot be deleted while their test case exists.
CREATE TRIGGER test_case_history_no_update BEFORE UPDATE ON test_case_history
BEGIN SELECT RAISE(ABORT, 'test_case_history is append-only'); END;
CREATE TRIGGER test_case_history_no_delete BEFORE DELETE ON test_case_history
WHEN EXISTS (SELECT 1 FROM test_cases WHERE id = OLD.test_case_id)
BEGIN SELECT RAISE(ABORT, 'test_case_history is append-only'); END;
