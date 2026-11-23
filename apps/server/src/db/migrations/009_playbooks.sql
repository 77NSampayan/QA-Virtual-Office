-- Pass P1: agent playbooks. The roster (roles, allowed tools, instructions, checklists) lives in code and is version
-- controlled; this table holds only what a person may change: the agent's display name and extra house rules.
-- Names are unique (case-insensitive) because "a reviewer is not the writer" is enforced by identity.
CREATE TABLE playbooks (
  id          TEXT PRIMARY KEY,
  agent_name  TEXT NOT NULL CHECK (length(trim(agent_name)) BETWEEN 2 AND 30),
  house_rules TEXT NOT NULL DEFAULT '' CHECK (length(house_rules) <= 2000),
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_playbooks_name ON playbooks(lower(trim(agent_name)));
