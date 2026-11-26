-- Pass 3 (A3b): the most recent CI/CD runs of a connection (read-only copy), and the refresh/polling state.
-- Only these fields are ever stored: the run's id on the provider, pipeline name, branch, status, start and finish
-- time, the first 7 characters of the commit id and a link on the provider's own site. The person who triggered a
-- run, commit messages, pull request titles, logs and artifacts are never read, so they cannot be stored.
CREATE TABLE ci_runs (
  id            TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES ci_connections(id) ON DELETE CASCADE,
  external_id   TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 40),
  name          TEXT NOT NULL CHECK (length(name) <= 200),
  branch        TEXT NOT NULL DEFAULT '' CHECK (length(branch) <= 200),
  status        TEXT NOT NULL CHECK (status IN ('queued','running','passed','failed','cancelled','other')),
  started_at    TEXT,
  finished_at   TEXT,
  sha7          TEXT NOT NULL DEFAULT '' CHECK (length(sha7) <= 7),
  url           TEXT NOT NULL DEFAULT '' CHECK (length(url) <= 500),
  UNIQUE (connection_id, external_id)
);
CREATE INDEX idx_ci_runs_connection ON ci_runs(connection_id, started_at);

ALTER TABLE ci_connections ADD COLUMN runs_as_of TEXT;                          -- last SUCCESSFUL read
ALTER TABLE ci_connections ADD COLUMN last_refresh_at TEXT;                     -- last attempt, successful or not
ALTER TABLE ci_connections ADD COLUMN last_refresh_ok INTEGER CHECK (last_refresh_ok IS NULL OR last_refresh_ok IN (0, 1));
ALTER TABLE ci_connections ADD COLUMN last_refresh_message TEXT NOT NULL DEFAULT '' CHECK (length(last_refresh_message) <= 300);
ALTER TABLE ci_connections ADD COLUMN etag TEXT;                                -- GitHub's "has anything changed" validator
ALTER TABLE ci_connections ADD COLUMN backoff_until TEXT;                       -- the provider asked us to wait
-- Polling is OFF unless a person turns it on; it stops by itself at polling_until.
ALTER TABLE ci_connections ADD COLUMN polling_enabled INTEGER NOT NULL DEFAULT 0 CHECK (polling_enabled IN (0, 1));
ALTER TABLE ci_connections ADD COLUMN polling_until TEXT;
