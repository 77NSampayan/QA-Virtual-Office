-- Pass 1B: UI/API session auth (hashed tokens only) and latest status-line snapshot per session.

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Latest snapshot per session. Numbers and a model id/name only; usage figures are exactly what
-- Claude Code reports (billing/subscription spend is not available through Claude Code).
CREATE TABLE statusline_snapshots (
  session_id          TEXT PRIMARY KEY,
  project_id          TEXT,
  model_id            TEXT,
  model_name          TEXT,
  cost_usd            REAL,
  duration_ms         INTEGER,
  api_duration_ms     INTEGER,
  context_used_pct    REAL,
  context_window_size INTEGER,
  five_hour_pct       REAL,
  five_hour_resets_at TEXT,
  seven_day_pct       REAL,
  seven_day_resets_at TEXT,
  updated_at          TEXT NOT NULL
);
