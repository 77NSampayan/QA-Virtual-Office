# CI/CD Operator robot type (2026-11-25)

**Scope:** a new robot type, `ci_operator`, for the CI/CD Control room that the office already had (empty, "Reserved for pipelines").

**Migration:** none needed. `robots.robot_type` and `robots.role` are plain `TEXT` columns with no CHECK constraint (001_init.sql); the allowed values are enforced in code (`isRobotType`, `packages/shared/src/robots.ts`), so no SQL migration, no data rewrite and no change to existing robots. Existing robots keep their type. A robot becomes a CI/CD Operator only when you choose it (Team page, robot editor) or when a session's role says so.

- Shared: type, label "CI/CD Operator", specialty, workstation "Pipeline console", department Automation, default palette.
- Sprites: its own silhouette (notched head, spikes, hover base, belt), two build lights, a pipeline-arrow chest icon and a pipeline-stages station; every existing sprite frame is byte-identical (snapshot diff: 80 added lines, 0 removed).
- Office: `ci_operator` already mapped to the CI/CD Control room; no layout change. Demo mode is unchanged (no demo CI robot, so demo counts stay as they were).
- Pickers (robot editor, sprite gallery) list it automatically.

| Check | Evidence |
|---|---|
| 8 types look different in every status; 8 workstations differ | `apps/web/test/sprites.test.ts` |
| Server accepts the type via PATCH; invalid types still refused | `apps/server/test/robots-ui-api.test.ts` |
| Office places it in the CI/CD room | `apps/web/test/office.test.ts`, `e2e/c-office.test.ts` |
