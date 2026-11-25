# Pass 3, checkpoint D1: Test Data Management (2026-11-25)

**Scope (my default, no questions asked):** test data profiles per project and environment holding FAKE values, placeholders and secret references; refusal of real-looking data; a masking helper for pasted text; copy as NAME=value lines. **Not in D1:** agent tools to read profiles (so Quinn and Axel cannot yet pick a profile), linking profiles to test cases, importing from files or databases, generating fake data in bulk, any connection to a real system.

**How it stays safe:** only a person creates, edits and deletes; a fixed value that looks like real personal data or a secret is refused with a reason per field and nothing is saved; a field named like a secret can only be a placeholder or a secret reference; a secret reference is only an environment variable NAME. The masking helper keeps nothing.

| # | Check | Result | Evidence |
|---|---|---|---|
| D1-1 | Fictional values accepted; real-looking e-mails, phones, SSN, cards, tokens, keys, private IPs refused with a reason; a real value hidden beside safe ones still caught | Pass | `packages/shared/test/testData.test.ts` |
| D1-2 | Secret-named fields cannot be fixed values; secret references are names only; placeholders must look like placeholders | Pass | same |
| D1-3 | Create, read, edit, delete; one name per project and environment; refused edits change nothing; project with profiles cannot be removed | Pass | `apps/server/test/qa-test-data.test.ts` |
| D1-4 | Agent and system refused for every action; masking helper stores nothing | Pass | same |
| D1-5 | Page: refusal shown per field, save, list, masking helper, edit rules, delete, 360 px; agent, hook token and cookie-less request refused | Pass | `e2e/test-data.test.ts` |

**Not verified:** detection quality on your real data formats (it uses the app's redaction engine, which is tuned for common patterns and can miss unusual ones, so treat the check as a safety net, not a guarantee); national ID formats beyond those the engine knows.
