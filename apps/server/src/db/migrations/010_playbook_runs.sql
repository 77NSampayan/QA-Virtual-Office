-- Pass P2/P4: one row per launched agent session ("run"). Only a HASH of the run credential is stored. A run is bound to
-- a playbook, an agent name (a snapshot, so a later rename does not rewrite history) and one project, and it expires.
CREATE TABLE playbook_runs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  playbook_id TEXT NOT NULL,
  agent_name  TEXT NOT NULL,
  role        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  started_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE INDEX idx_runs_project ON playbook_runs(project_id, started_at);

-- Who drafted a test case (empty = a person, an import, or an agent that is not attributed).
ALTER TABLE test_cases ADD COLUMN drafted_by_name TEXT NOT NULL DEFAULT '';
ALTER TABLE test_cases ADD COLUMN drafted_by_run TEXT;

-- The audit trail says which named agent made each call (still never the content).
ALTER TABLE agent_audit ADD COLUMN agent_name TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_audit ADD COLUMN role TEXT NOT NULL DEFAULT '';

-- A robot that belongs to a named agent is never handed to an ordinary session.
ALTER TABLE robots ADD COLUMN playbook_id TEXT;
CREATE UNIQUE INDEX idx_robots_playbook ON robots(playbook_id, project_id) WHERE playbook_id IS NOT NULL;
