-- QA Virtual Office: Pass 1A schema.
-- Privacy: `projects` holds only safe display data. Actual paths live in `project_paths`,
-- which is read only by the policy writer, folder-key re-linking and the edit-form endpoint.

CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  alias         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  type          TEXT NOT NULL DEFAULT 'general',
  settings_json TEXT NOT NULL DEFAULT '{}',
  archived      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE project_paths (
  project_id      TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  path_entered    TEXT NOT NULL,
  path_lexical    TEXT NOT NULL UNIQUE,
  path_canonical  TEXT,
  path_exists     INTEGER NOT NULL,
  last_checked_at TEXT NOT NULL
);

CREATE TABLE robots (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  robot_type   TEXT NOT NULL DEFAULT 'qa_analyst',
  role         TEXT NOT NULL DEFAULT 'qa_analyst',
  palette_json TEXT NOT NULL DEFAULT '{}',
  project_id   TEXT REFERENCES projects(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE sessions (
  session_id        TEXT PRIMARY KEY,
  project_id        TEXT REFERENCES projects(id) ON DELETE SET NULL,
  folder_key        TEXT,
  robot_id          TEXT REFERENCES robots(id) ON DELETE SET NULL,
  origin            TEXT NOT NULL CHECK (origin IN ('new','resume','fork','resume_unlinked')),
  parent_session_id TEXT,
  model             TEXT,
  permission_mode   TEXT,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  last_event_at     INTEGER NOT NULL,
  status            TEXT NOT NULL,
  status_source     TEXT NOT NULL CHECK (status_source IN ('event','inferred')),
  flags_json        TEXT NOT NULL,
  start_observed    INTEGER NOT NULL,
  last_rule         TEXT
);
CREATE INDEX idx_sessions_project ON sessions(project_id);
CREATE INDEX idx_sessions_last_event ON sessions(last_event_at);

-- All sessions scope only: opaque folder keys used to re-link unregistered sessions later.
CREATE TABLE session_folder_keys (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  kid        TEXT NOT NULL,
  ord        INTEGER NOT NULL,
  PRIMARY KEY (session_id, key)
);
CREATE INDEX idx_folder_keys_key ON session_folder_keys(key);

CREATE TABLE subagents (
  session_id    TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL,
  agent_type    TEXT NOT NULL,
  status        TEXT NOT NULL,
  status_source TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  stopped_at    INTEGER,
  turn_failed   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, agent_id)
);

CREATE TABLE agent_events (
  id                  TEXT PRIMARY KEY,
  dedupe_key          TEXT NOT NULL UNIQUE,
  session_id          TEXT NOT NULL,
  project_id          TEXT,
  event               TEXT NOT NULL,
  raw_event_name      TEXT,
  agent_id            TEXT,
  agent_type          TEXT,
  tool_name           TEXT,
  tool_use_id         TEXT,
  notification_type   TEXT,
  source              TEXT,
  reason              TEXT,
  error               TEXT,
  permission_mode     TEXT,
  model               TEXT,
  duration_ms         INTEGER,
  is_interrupt        INTEGER,
  file_category       TEXT,
  command_category    TEXT,
  background_tasks    INTEGER,
  status_after        TEXT NOT NULL,
  status_source_after TEXT NOT NULL,
  rule                TEXT NOT NULL,
  occurred_at         TEXT NOT NULL,
  received_at         TEXT NOT NULL,
  origin_source       TEXT NOT NULL DEFAULT 'hook' CHECK (origin_source IN ('hook','statusline','replay')),
  content_json        TEXT
);
CREATE INDEX idx_events_session ON agent_events(session_id, received_at);

CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  priority   TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  project_id TEXT,
  session_id TEXT,
  created_at TEXT NOT NULL,
  read_at    TEXT
);
CREATE INDEX idx_notifications_created ON notifications(created_at);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
