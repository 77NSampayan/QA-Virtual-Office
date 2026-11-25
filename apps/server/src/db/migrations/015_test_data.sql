-- Pass 3 (D1): test data profiles. FAKE or masked data only, plus references to secrets (the NAME of an environment
-- variable), never the secret. The service refuses values that look like real personal data or secrets; these
-- constraints keep the shape honest. Only a person creates and edits profiles in D1 (agents have no tools for them).
CREATE TABLE test_data_profiles (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  seq         INTEGER NOT NULL,
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 80),
  environment TEXT NOT NULL DEFAULT '' CHECK (length(environment) <= 40),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (project_id, seq)
);
-- one profile name per project and environment (case-insensitive)
CREATE UNIQUE INDEX idx_test_data_profile_name ON test_data_profiles(project_id, lower(name), lower(environment));

CREATE TABLE test_data_fields (
  id         TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES test_data_profiles(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  key        TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 64),
  kind       TEXT NOT NULL CHECK (kind IN ('fixed','placeholder','secret_ref')),
  value      TEXT NOT NULL CHECK (length(value) <= 500),
  UNIQUE (profile_id, key)
);
CREATE INDEX idx_test_data_fields_profile ON test_data_fields(profile_id, position);
