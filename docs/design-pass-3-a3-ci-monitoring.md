# Pass 3, A3: read-only CI/CD monitoring: design for approval (2026-11-25)

**Status: DESIGN ONLY. No code has been written.** This is the first feature in the app that talks to the internet and holds a credential. Your answers to the three decisions are recorded below (**GitHub Actions and Azure DevOps; Windows-protected token file; opt-in polling from the start**). The design as a whole still needs your go-ahead before A3a starts.

## 1. What it is, and what it is not
Show, in the Test Automation page, the recent runs of a project's CI pipelines: name, branch, status (queued, running, passed, failed, cancelled), when, how long, and a link that opens the run in the provider's own site.

It is **read-only**. It never starts, re-runs, cancels or approves a run, never changes a repository, never downloads logs or artifacts, never touches a test case, defect or task. A failed pipeline is shown as failed and nothing else happens (no automatic defect, no automatic "failed" test result, no classification). To bring CI test results into the app you still import a JUnit file yourself (A1).

## 2. What is sent, what is stored
| | Detail |
|---|---|
| **Sent out** | Only an HTTPS request to the provider's API containing the access token and the repository name you typed (for example `owner/repo`). No project alias, folder path, user name, machine name, test data or QA records. A generic client name, no contact details. |
| **Stored** | Per connection: provider, repository name, a display name. Per run (last 50 per connection, kept 30 days): run id, workflow name, branch, status, start and end time, the first 7 characters of the commit id, the provider's link. |
| **Never stored or shown** | The person who triggered the run, commit messages, pull request titles, logs, artifacts, e-mail addresses (all can contain personal data). |
| **The token** | Never in the database, backups, exports, logs, API responses or the screen after you paste it. Details in section 4. |

## 3. Network rules (the part that must be hard to get wrong)
- Outbound calls go only to a **fixed allow-list of provider hosts written in the code** (first cut: `api.github.com` and `dev.azure.com`). The host is never taken from user input, so the app cannot be pointed at your internal network or at `localhost` (no server-side request forgery).
- HTTPS only; certificates verified; no redirects followed to another host; 10 second timeout; responses larger than 1 MB are dropped; nothing from the response is executed or rendered as HTML (shown as text only, links opened only if they are `https://` on the same provider host).
- Rate limits are respected (conditional requests with ETag, back off on 403/429). Default is **manual Refresh only**; polling is a separate opt-in (section 7).
- If the network is down or the token is rejected, the page says so plainly and shows the last saved runs marked "as of <time>". It never invents a status.

## 4. The token
Recommended tokens: **GitHub**, a fine-grained personal access token, read-only, limited to one repository (Actions: read, Metadata: read). **Azure DevOps**, a personal access token with only the **Build: Read** scope, limited to one organisation. The app cannot verify the scope of these tokens, so the screen says exactly what to create and warns against broad ones. One token per connection (a GitHub token is never sent to Azure DevOps or the reverse).

**DECISION 2 (chosen: option a): where the token lives.** Options:
- **(a) Windows-protected file, recommended.** The server encrypts the token with the current Windows user's DPAPI and writes it to a separate file in the data folder (current-user-only ACL, like the other secrets). It is not in the SQLite database, so backups and exports never contain it, and another Windows user (or a copied file on another PC) cannot decrypt it. Implemented with the PowerShell that ships with Windows 10 and 11, token passed on standard input (never on a command line), no new dependency. Works in the desktop app and in browser mode.
- **(b) Environment variable reference only.** You set an environment variable (for example `QAVO_GITHUB_TOKEN`) and the app stores only its name, like the secret references in Test Data. Nothing secret is stored by the app at all. Downside: Windows apps started from the Start menu only see variables set before they launch, which is awkward for a desktop app.
- **(c) Electron `safeStorage`.** Same protection as (a) but only works inside the desktop app, not in browser mode.

The token is wrapped so it cannot leak by accident: the redaction engine already masks GitHub token formats in logs and agent output; error messages from the provider are scrubbed before they are shown or logged; the token is held in memory only for the duration of a request.

## 5. Who can do what
- Only the signed-in person can connect, test, refresh and disconnect (routes need your session cookie; the agent token, run tokens and hook token are refused; the service checks the actor, as everywhere else).
- Agents get **no tools** for CI in A3.
- Disconnect deletes the token file and every saved run for that connection.

## 6. Providers
**DECISION 1 (chosen: GitHub Actions and Azure DevOps): first cut.**
- GitHub Actions only. One well-documented API, the repository itself is on GitHub, one fixed host to allow-list. The code is written behind a small provider interface so others can be added.
- **Azure DevOps (chosen, with GitHub).** Fixed host `dev.azure.com`; the **organisation and project names go into the URL path**, so they are validated strictly (organisation: letters, digits and dashes only; project: letters, digits, space, dot, dash, underscore; URL-encoded; no slashes, dots-only or `..`). Read with the Builds API (`GET /{org}/{project}/_apis/build/builds`, top 50), sent with Basic authentication using the token (empty user name). Kept: build number, pipeline name, branch, status and result, start and finish time, first 7 characters of the commit id, the build's web link. Dropped: who requested it, commit messages. The old `*.visualstudio.com` addresses and Azure DevOps Server (on-premises) are not supported.
- **Jenkins later and only with a separate decision:** the server address is user-supplied (usually inside your network), which is exactly the case the fixed allow-list exists to prevent. It would need an explicit "this host only" approval per connection, with local and private addresses handled deliberately.

## 7. Build in small checkpoints (stop for your review after each)
1. **A3a: connection and token.** Connect GitHub, protected token storage, Test connection (returns only ok/failed and the repo name), Disconnect. No run data yet.
1b. **A3a also covers Azure DevOps:** connect (organisation and project), Test connection, Disconnect.
2. **A3b: runs and polling.** Refresh button and the opt-in polling switch, runs table (provider, pipeline, status, branch, time, duration, link), "as of" label, error states, retention rules, for both providers.
3. **A3c (optional): the real pipeline status on the CI/CD Control room's wall screen in the office** (real data only; the screen stays at its standby pattern with no connection).

**DECISION 3 (chosen: opt-in polling from the start):** A3b ships with both a Refresh button and an **off-by-default** polling switch: every 5 minutes (never faster), only while the Test Automation page is open in a signed-in window, per connection, with ETag/back-off for GitHub and a hard minimum interval enforced by the server (not the browser). It stops on its own after 2 hours without a click. Turning it on is a visible, per-connection choice.

## 8. Threats considered
| Threat | Answer |
|---|---|
| Server-side request forgery (pointing the app at internal addresses) | Fixed host allow-list in code; no user-supplied URLs in the first cut |
| Token theft from disk or backups | Separate DPAPI-protected file, current-user ACL, never in the database, backups or exports |
| Token in logs or on screen | Never returned by any API; redaction on logs and errors; shown as "connected" only |
| Over-powerful token | Screen asks for a read-only, single-repository, fine-grained token; the app only ever sends GET requests |
| Hostile response content | Size cap, parsed as JSON only, stored as text, never rendered as HTML, link only if `https` on the provider host |
| Rate limit lockout or noisy polling | Polling off by default, 5 minute server-enforced minimum, 2 hour auto-stop, ETag, back-off |
| URL injection through the Azure DevOps organisation or project name | Strict character rules, URL-encoding, fixed host, no redirects |
| CSRF / another local program | Existing session cookie, Origin and CORP checks apply to the new routes |
| Personal data in CI metadata | Actor, commit messages and PR titles are dropped before anything is stored |
| Offline / provider outage | Last saved runs shown as "as of"; no invented status |

## 9. Tests I would write
A local fake GitHub and Azure DevOps server (the production code only ever uses the allow-listed hosts; tests inject a fetch function): success, 401, 403 rate limit, 404, timeout, oversized body, redirect to another host (refused), malicious fields (HTML, long strings) stored as inert text, actor and commit message never stored, token never present in any API response, log line, database row, backup or export, disconnect removes the token and runs, agent/run/hook tokens and cookie-less requests refused, host cannot be changed by input.

## 10. Not verified until a real connection exists
Behaviour against the real GitHub and Azure DevOps APIs with your tokens and repositories, and DPAPI encryption on a second Windows account. I would ask you to do one live connection test per provider at A3a with a throw-away read-only token.
