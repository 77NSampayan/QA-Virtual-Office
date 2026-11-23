-- Test-case import: the id a test case had in the team's own sheet ("Test Case ID"), so a re-import can skip what is
-- already there. Empty when the test case was written in the app. Unique per project (case-insensitive) when set.
ALTER TABLE test_cases ADD COLUMN external_id TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX idx_test_cases_external ON test_cases(project_id, lower(external_id)) WHERE external_id <> '';
