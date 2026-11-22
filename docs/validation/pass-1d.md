# Pass 1D: Validation Results (2026-11-22)

**What 1D delivers:** the Windows desktop shell (Electron 45): a signed-in window onto the office, a system-tray icon with an attention badge, Windows toast notifications for permission/input/failure events, minimize/close-to-tray, start with Windows (hidden), single instance, and a Desktop card in Settings. Launch with `npm run desktop`.

**Architecture decision (approved before building):** the Electron main process starts the existing server as a **child process on the system Node** (and attaches to a server that is already running). Reason: the native SQLite module is built for Node, not Electron, so one build cannot serve both. The packaged installer (Pass 5) must bundle a Node runtime.

**Environment:** Windows 11 Pro, Electron 45.4.1, Node 24.18, driven with playwright-core's Electron support. Each launch uses an isolated data folder, port and user-data folder; events are synthetic and go only to that isolated server.

**Automated:** `npm test` → 17 files, **342 passed, 1 skipped**. `npm run e2e` → 3 files, **46 passed** (5 + 15 from earlier checkpoints, 26 new desktop tests). Typecheck (now including the desktop app) and lint are clean.

| # | Criterion | Result | Evidence |
|---|---|---|---|
| D1 | A real permission prompt raises a Windows toast within 2 s; clicking it focuses the app | **Pass (automated); visual confirmation needed from you** | A real `PermissionRequest` event posted to the server produced a toast whose `show` event fired **31–41 ms** later (limit: 2000 ms). Clicking the toast restores a hidden window and opens the QA Control Room, which lists the waiting agent and tool. Also verified: input requests and failures toast; completion does not unless you opt in; the same notification is never toasted twice (WebSocket reconnect); the in-app "Send a test notification" button works; the tray tooltip and taskbar badge follow real session state (on when a prompt waits, off once it is answered). **Not automatable:** that Windows visibly displayed the toast (Focus Assist / Do Not Disturb can suppress it) and a physical click on it. The click is simulated by emitting the toast's click event; see "Please verify by hand" |
| D2 | Electron security checklist verified | **Pass** | Runtime checks on the real app: `contextIsolation` and `sandbox` on, `nodeIntegration` off (also in workers and subframes), `webSecurity` on, `webviewTag` off, no experimental features; DevTools cannot be opened; the page has no `require`, `process`, `Buffer` or `electron`; the preload exposes exactly four members and no raw IPC; navigating to another origin and `window.open` are blocked (no window created); fetches to any other origin are cancelled; geolocation, notifications and clipboard permissions are denied; no application menu; strict CSP served (`default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`); IPC accepts only the four known preference keys with validated values from the app's own main frame (bogus lists, `__proto__`, unknown keys and wrong types are rejected) and the preferences file contains only known keys. **Not applicable until packaging (Pass 5):** Electron fuses (RunAsNode, NODE_OPTIONS) and ASAR integrity apply to packaged binaries |
| D3 | Tray, minimize/restore, login item and single instance work on Windows 11 | **Pass (automated); look at the tray yourself** | Tray object exists; minimizing hides the window to the tray and showing it restores it; closing keeps the app and server running; a second launch exits by itself and the first window appears; **Start with Windows** writes a hidden-start login item to the user's Run key and removes it again (verified in the registry; the tests leave nothing behind); started with `--hidden` (as at login) the app lives in the tray with no window; the app-started server stops when the app quits, and an attached (already running) server keeps running. Tray and taskbar icons are drawn from the sprites (16×16 plus a 2× representation, with an alert dot) |
| D4 | Windows 10 | **Not tested** | This machine runs Windows 11. Listed as an open validation item |

## Please verify by hand (2 minutes)

1. `npm run desktop` (or double-check the tray icon: a small robot head near the clock).
2. Start `claude` in a registered folder in default permission mode and ask it to create a file.
3. A Windows toast **"Permission required"** should appear; clicking it should bring the app to the Control Room. If no toast appears, check Windows **Focus assist / Do Not Disturb**.
4. Right-click the tray icon: Open, Control Room, Minimize to tray, Start with Windows, Sound, Quit.

## Defects found and fixed during 1D

1. **`ELECTRON_RUN_AS_NODE` breaks the app.** VS Code sets this variable for its child processes, which makes Electron start as plain Node and crash with "Cannot read properties of undefined (reading 'setPath')". Fixed: `npm run desktop` uses a launcher that clears it, and the tests do too.
2. **A failed test left a login item behind** (the cleanup hook ran after the app had closed). It would have launched the development app at every Windows login. I removed the entry from the registry, then hardened the test (try/finally, plus a safety net that deletes only an entry pointing at this repo's development Electron) and verified the registry is clean after every run.
3. **Wrong assumptions in my tests:** Electron reports no `devTools` field (now checked behaviourally) and registers login items under the AppUserModelID rather than the product name.
4. **A stray `bun` dependency** had entered the root `package.json` during 1B (pushed with it). Nothing used it, so it is removed. I could not determine how it got there.
5. **Blank window after `npm run desktop` (reported by the product owner).** The server answered requests for the web app's script file with the HTML page, so the browser refused it ("server responded with a MIME type of text/html"). Cause: the static-file plugin was registered with `wildcard: false`, which routes only the files that existed **when the server started**; a server started before a web rebuild (new hashed file names) could not serve the new bundle, and the catch-all returned the HTML page for any missing file. **This also explains the "bad web bundle" seen earlier, which I had been unable to reproduce.** Fixed: files are looked up on every request, and only extension-less routes fall back to the app page (a missing file is a real 404). Regression tests in `apps/server/test/static.test.ts` (asset added after startup, missing assets, API 404s, path traversal). Verified against the live setup: the desktop window renders with real data.

## Not done / open

- Packaged installer, bundled Node, fuses, ASAR integrity, a Start Menu shortcut with the AppUserModelID (so toasts carry the app's name and icon): **Pass 5**. In development, toasts are attributed to the Electron host.
- Windows 10 (D4).
- The visible toast and the tray menu have not been seen by a human (see above).
