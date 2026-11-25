# UI redesign, slice 3: robot characters (2026-11-25)

**Scope:** how the robots look. No backend, schema, event, WebSocket, MCP, security or privacy change; no new dependency; no change to which states exist or what triggers them. The seven robot types are unchanged (the CI/CD Operator type was left out by decision).

**Before:** all seven types shared one body. A type differed only by a head decoration, a small chest icon and a default colour pair, so two robots with the same colours were almost the same figure.

**What changed**
- Each type now has its own outline (`CHASSIS` in `sprites/robot.ts`): head shape (round, box, notched), shoulders (none, pads, wide plates, spikes), what it stands on (feet, treads with turning wheels, a hover pad with a glowing thruster) and an optional belt stripe.

| Type | Head | Shoulders | Stands on | Belt |
|---|---|---|---|---|
| QA Analyst | round | none | feet | no |
| Manual Tester | box | pads | feet | yes |
| Automation Engineer | notched | wide plates | feet | no |
| API Tester | round | spikes | treads | no |
| Regression Tester | box | none | treads | yes |
| Bug Investigator | notched | pads | feet | yes |
| QA Lead | box | wide plates | hover pad | no |

- The face, the arms and every status effect are exactly the same for every type, so a state reads the same way on every robot. A robot is still a pure function of (type, status, palette, frame): nothing random, no clock, nothing that can move without a real event.
- The desk, the lounge and all positioning are unchanged.

| # | Check | Result | Evidence |
|---|---|---|---|
| S3-1 | With identical colours, every pair of types has a different outline in every status and frame; any two types differ by at least 6 pixels when idle | Pass | `apps/web/test/sprites.test.ts` (slice 3) |
| S3-2 | The face is identical across types for every status and frame | Pass | same |
| S3-3 | Sprites stay inside their 24x24 cell and stand on the bottom row | Pass | same |
| S3-4 | Existing sprite tests (all ten statuses, animation, colour, no randomness) and the pixel snapshot | Pass (snapshot regenerated on purpose) | same |
| S3-5 | It looks right | For your review | the Sprite gallery (Settings, About), and screenshots in the review folder |

**Known:** the chest icons and head decorations remain small at the default zoom; the shape differences read best at the Team page preview size and when zoomed in.
