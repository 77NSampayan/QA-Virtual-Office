-- V4b: permission requests that a person can answer from the office.
-- Only a human can allow or deny (CHECK, written with COALESCE because a NULL check result passes in SQLite),
-- a decision is final (trigger), and the command summary is erased as soon as the request is answered or expires.
CREATE TABLE permission_requests (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
  tool_name   TEXT NOT NULL,
  -- short, redacted, path-masked description; NULL when tool-input capture is off; wiped when answered or expired
  summary     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','allowed','denied','expired')),
  reason      TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  decided_at  INTEGER,
  decided_by  TEXT CHECK (decided_by IS NULL OR decided_by = 'human'),
  CHECK (status NOT IN ('allowed','denied') OR (COALESCE(decided_by, '') = 'human' AND decided_at IS NOT NULL))
);
CREATE INDEX idx_perm_status ON permission_requests(status, expires_at);
CREATE INDEX idx_perm_session ON permission_requests(session_id, status);

CREATE TRIGGER permission_decision_is_final BEFORE UPDATE OF status ON permission_requests
WHEN OLD.status <> 'pending'
BEGIN SELECT RAISE(ABORT, 'a permission decision is final'); END;
