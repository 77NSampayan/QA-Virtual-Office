-- Pass 2D: audit trail of what agents did through the MCP surface.
-- Only the tool name, the project and the outcome are stored: never arguments, text or results.
CREATE TABLE agent_audit (
  id         TEXT PRIMARY KEY,
  at         TEXT NOT NULL,
  tool       TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  outcome    TEXT NOT NULL CHECK (outcome IN ('ok','denied','error')),
  code       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_agent_audit_at ON agent_audit(at);
CREATE TRIGGER agent_audit_no_update BEFORE UPDATE ON agent_audit
BEGIN SELECT RAISE(ABORT, 'agent_audit is append-only'); END;
