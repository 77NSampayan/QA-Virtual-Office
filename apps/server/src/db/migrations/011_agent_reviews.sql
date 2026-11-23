-- Pass P3: a review is a RECOMMENDATION by a named reviewer agent about one test case. It never changes the test case's
-- status: approving and rejecting stay human-only (migrations 003/004). The rule "a reviewer is not the writer" is
-- enforced here by the database itself, not only by the service and the tool list.
CREATE TABLE agent_reviews (
  id            TEXT PRIMARY KEY,
  subject_kind  TEXT NOT NULL CHECK (subject_kind IN ('test_case')),
  subject_id    TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  run_id        TEXT NOT NULL REFERENCES playbook_runs(id),
  reviewer_name TEXT NOT NULL CHECK (length(trim(reviewer_name)) > 0),
  verdict       TEXT NOT NULL CHECK (verdict IN ('recommend_approve', 'changes_requested')),
  notes         TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  -- fingerprint of the content that was reviewed: a later edit makes the review outdated
  subject_hash  TEXT NOT NULL CHECK (length(subject_hash) = 64),
  created_at    TEXT NOT NULL,
  CHECK (verdict <> 'changes_requested' OR length(trim(notes)) > 0)
);
CREATE INDEX idx_agent_reviews_subject ON agent_reviews(subject_id, created_at);

-- The reviewer must be the agent the run was launched as, working on the run's own project.
CREATE TRIGGER agent_reviews_identity BEFORE INSERT ON agent_reviews
WHEN NOT EXISTS (
  SELECT 1 FROM playbook_runs r JOIN test_cases t ON t.id = NEW.subject_id
  WHERE r.id = NEW.run_id AND r.agent_name = NEW.reviewer_name AND r.project_id = t.project_id
)
BEGIN SELECT RAISE(ABORT, 'the reviewer must be the launched agent, on its own project'); END;

-- A reviewer never reviews its own work: not the same run, and not the same agent name.
CREATE TRIGGER agent_reviews_not_own_work BEFORE INSERT ON agent_reviews
WHEN EXISTS (
  SELECT 1 FROM test_cases t
  WHERE t.id = NEW.subject_id
    AND (t.drafted_by_run = NEW.run_id OR (t.drafted_by_name <> '' AND lower(trim(t.drafted_by_name)) = lower(trim(NEW.reviewer_name))))
)
BEGIN SELECT RAISE(ABORT, 'a reviewer cannot review its own work'); END;

-- Append-only: a review can never be edited or removed (it goes with its test case only).
CREATE TRIGGER agent_reviews_no_update BEFORE UPDATE ON agent_reviews
BEGIN SELECT RAISE(ABORT, 'agent_reviews is append-only'); END;
CREATE TRIGGER agent_reviews_no_delete BEFORE DELETE ON agent_reviews
WHEN EXISTS (SELECT 1 FROM test_cases WHERE id = OLD.subject_id)
BEGIN SELECT RAISE(ABORT, 'agent_reviews is append-only'); END;
