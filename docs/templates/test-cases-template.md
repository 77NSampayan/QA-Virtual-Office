# Test case import template

Paste this table (Markdown) or copy the same columns from a spreadsheet into **Manual QA → Test cases → Import from table**.
Only **Test Case Description** is required. Delete any column you do not use; the order does not matter.

| Module | Sub Module | Test Case ID | Test Case Description | Test Case Type | Pre-Condition | Steps | Expected Result | Test Data | Priority | Requirement Refs | Assigned Tester | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Authentication | Login | TC_001 | Sign in with valid credentials | Positive | The account exists | 1. Open the login page<br>2. Enter the email and password<br>3. Press Login | The home page is shown | Use the test account | High | FR-1 | | Smoke |
| Authentication | Login | TC_002 | Sign in with a wrong password | Negative | The account exists | 1. Open the login page<br>2. Enter a wrong password<br>3. Press Login | An error message is shown and nobody is signed in | | High | FR-1 | | |

## How the columns are read

| Your column | Becomes | Notes |
|---|---|---|
| Module, Sub Module | Scenario ("Module › Sub Module") | |
| Test Case ID | Test Case ID shown under the TC-0001 code | Re-importing skips IDs that already exist in the project |
| Test Case Description | Title (first line, up to 200 characters) | A longer or multi-line text is also kept in full as the description |
| Test Case Type | Type | Positive, Negative, Boundary value (BVA), Equivalence partitioning (EP), Decision table, State transition, Exploratory, Regression, Integration, End-to-end (E2E). Anything else becomes Positive and the preview says so |
| Pre-Condition | Preconditions | |
| Steps | Steps | One per line or `<br>`; "1." / "2)" numbering is removed. Needed before a case can be approved |
| Expected Result | Expected result | Needed before a case can be approved |
| Test Data | Test data | Do not put real customer data or real passwords here |
| Priority | Priority | Critical, High, Medium, Low (also Blocker/P1, Major/P2, Normal/P3, Minor/P4). Default Medium |
| Requirement Refs | Links to requirements | Separate with commas; unknown refs are reported, not created |
| Assigned Tester | Assigned tester | |
| Remarks | Added to the description as "Remarks: …" | |

## Columns that are never imported

Actual Result, DE Exception Message, Status, Test Execution Status, Execution Date, Defect ID, Proposed Solution, Action Owner,
Action Item, Automation Feasibility / Script / Remarks, Test Evidence Link, Test Inclusion, Defect History.
A result only counts when a person records it on the execution board, so an imported "Passed" never becomes a result.
They are listed in the preview as "Not imported".

Every imported case is a **draft** written by you. Approval stays a separate step that only you can take.
