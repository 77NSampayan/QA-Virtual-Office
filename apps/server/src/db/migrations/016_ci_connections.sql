-- Pass 3 (A3a): a connection from a project to a CI/CD provider (GitHub Actions or Azure DevOps), READ-ONLY.
-- The access token is NEVER stored here (or in any backup or export): it lives in a separate DPAPI-protected file
-- named after the connection id. This table holds only what is needed to address the provider and to show the
-- result of the last connection test.
CREATE TABLE ci_connections (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  provider        TEXT NOT NULL CHECK (provider IN ('github', 'azure_devops')),
  -- GitHub: owner and repository. Azure DevOps: organisation and project.
  owner           TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 50),
  name            TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  last_tested_at  TEXT,
  last_test_ok    INTEGER CHECK (last_test_ok IS NULL OR last_test_ok IN (0, 1)),
  last_test_message TEXT NOT NULL DEFAULT '' CHECK (length(last_test_message) <= 300),
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_ci_connection_target ON ci_connections(project_id, provider, lower(owner), lower(name));
