-- Pass 3 (A4): automation SCRIPT DRAFTS written by a named writer agent (Axel) and reviewed by a different named
-- reviewer agent (Vera). A script is TEXT kept in this app: it is never run and never written into the project.
-- Approving or rejecting is human-only, enforced here by the database (CHECK), like test cases and defects.
-- A review is a recommendation: it never changes a script's status. The reviewer-is-not-the-writer rule and the
-- identity rule are enforced by triggers, exactly as for test case reviews (011).
CREATE TABLE automation_scripts (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  seq             INTEGER NOT NULL,
  title           TEXT NOT NULL CHECK (length(trim(title)) > 0),
  framework       TEXT NOT NULL,
  test_case_id    TEXT REFERENCES test_cases(id) ON DELETE SET NULL,
  content         TEXT NOT NULL CHECK (length(content) > 0 AND length(content) <= 50000),
  notes           TEXT NOT NULL DEFAULT '',
  -- the writer's answer to the latest review (one short note, replaced each time)
  writer_reply    TEXT NOT NULL DEFAULT '' CHECK (length(writer_reply) <= 1000),
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','rejected')),
  version         INTEGER NOT NULL DEFAULT 1,
  drafted_by_name TEXT NOT NULL CHECK (length(trim(drafted_by_name)) > 0),
  drafted_by_run  TEXT NOT NULL REFERENCES playbook_runs(id),
  decided_by      TEXT CHECK (decided_by IS NULL OR decided_by = 'human'),
  decided_at      TEXT,
  decision_note   TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (project_id, seq),
  CHECK (status = 'draft' OR (COALESCE(decided_by, '') = 'human' AND decided_at IS NOT NULL))
);
CREATE INDEX idx_automation_scripts_project ON automation_scripts(project_id, status);

-- Once a person has decided, the text can no longer change.
CREATE TRIGGER automation_scripts_frozen BEFORE UPDATE ON automation_scripts
WHEN OLD.status <> 'draft' AND (NEW.content <> OLD.content OR NEW.title <> OLD.title OR NEW.framework <> OLD.framework OR NEW.status <> OLD.status)
BEGIN SELECT RAISE(ABORT, 'a decided script can no longer change'); END;

CREATE TABLE automation_script_reviews (
  id            TEXT PRIMARY KEY,
  script_id     TEXT NOT NULL REFERENCES automation_scripts(id) ON DELETE CASCADE,
  run_id        TEXT NOT NULL REFERENCES playbook_runs(id),
  reviewer_name TEXT NOT NULL CHECK (length(trim(reviewer_name)) > 0),
  verdict       TEXT NOT NULL CHECK (verdict IN ('recommend_approve', 'changes_requested')),
  notes         TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  -- fingerprint of what was reviewed: a later revision makes the review outdated
  script_hash   TEXT NOT NULL CHECK (length(script_hash) = 64),
  created_at    TEXT NOT NULL,
  CHECK (verdict <> 'changes_requested' OR length(trim(notes)) > 0)
);
CREATE INDEX idx_script_reviews_script ON automation_script_reviews(script_id, created_at);

CREATE TRIGGER script_reviews_identity BEFORE INSERT ON automation_script_reviews
WHEN NOT EXISTS (
  SELECT 1 FROM playbook_runs r JOIN automation_scripts s ON s.id = NEW.script_id
  WHERE r.id = NEW.run_id AND r.agent_name = NEW.reviewer_name AND r.project_id = s.project_id
)
BEGIN SELECT RAISE(ABORT, 'the reviewer must be the launched agent, on its own project'); END;

CREATE TRIGGER script_reviews_not_own_work BEFORE INSERT ON automation_script_reviews
WHEN EXISTS (
  SELECT 1 FROM automation_scripts s
  WHERE s.id = NEW.script_id
    AND (s.drafted_by_run = NEW.run_id OR lower(trim(s.drafted_by_name)) = lower(trim(NEW.reviewer_name)))
)
BEGIN SELECT RAISE(ABORT, 'a reviewer cannot review its own work'); END;

CREATE TRIGGER script_reviews_no_update BEFORE UPDATE ON automation_script_reviews
BEGIN SELECT RAISE(ABORT, 'automation_script_reviews is append-only'); END;
CREATE TRIGGER script_reviews_no_delete BEFORE DELETE ON automation_script_reviews
WHEN EXISTS (SELECT 1 FROM automation_scripts WHERE id = OLD.script_id)
BEGIN SELECT RAISE(ABORT, 'automation_script_reviews is append-only'); END;
