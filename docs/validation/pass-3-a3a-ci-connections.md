# Pass 3, checkpoint A3a: CI/CD connections and protected token (2026-11-25)

**Scope (approved design: `docs/design-pass-3-a3-ci-monitoring.md`):** connect a project to GitHub Actions or Azure DevOps, store the token in Windows protected storage, Test connection, Replace token, Disconnect. **Not in A3a:** showing pipeline runs, polling, the office wall screen (A3b and A3c).

| # | Check | Result | Evidence |
|---|---|---|---|
| A3a-1 | Names that could change the address are refused (`a/b`, `..`, `?`, `#`, `@`, spaces, trailing dot...); tokens must be 20 to 400 visible characters | Pass | `apps/server/test/ci-connections.test.ts` |
| A3a-2 | Requests go only to `api.github.com` / `dev.azure.com`, GET, project names encoded, token only in the Authorization header and never in a URL; other hosts, `http`, look-alike hosts, URLs with credentials, localhost and the other provider's host are refused before any call | Pass | same |
| A3a-3 | Redirects never followed, timeout set, oversized and non-JSON answers and network errors handled; error text carrying the token does not escape | Pass | same |
| A3a-4 | Every provider answer becomes one of our own sentences, none containing the token or provider text | Pass | same, `e2e/ci-connections.test.ts` |
| A3a-5 | Token goes to protected storage only: not in any database table, not in any API answer, not in any file under the data folder (logs, database), not on the screen after entry | Pass | same |
| A3a-6 | Windows DPAPI: the stored file is encrypted bytes (not the token), round-trips, replace and remove work, path tricks in the id are refused | Pass | same (real DPAPI on this PC) |
| A3a-7 | If protected storage fails nothing is connected; connecting alone makes no network call; testing limited to once per 3 seconds; missing token reported | Pass | same |
| A3a-8 | Replace token clears the old test result; Disconnect deletes the token file and the row; project with a connection cannot be removed | Pass | same |
| A3a-9 | Agent, system, run token, agent token, hook token and cookie-less requests refused; a request body with a `host` field is refused | Pass | same |
| A3a-10 | Page: connect GitHub and Azure DevOps with provider-specific instructions, token cleared from the screen, rejected token explained, replace, disconnect, 360 px | Pass | `e2e/ci-connections.test.ts` |

**Not verified (needs you):** a live connection to the real GitHub and the real Azure DevOps with a throw-away read-only token (all tests use a local stand-in for the provider); DPAPI decryption failing on a second Windows account (by design, not exercised); what Azure DevOps answers for a token with the wrong scope (the app treats a sign-in page or 203 as "token not accepted").

**Live test for you (about 5 minutes per provider):** create a throw-away read-only token as the screen describes, connect, press Test connection and expect "Connected"; then Disconnect and confirm the token is gone from `%LOCALAPPDATA%\QA Virtual Office\secrets`; finally revoke the token at the provider.
