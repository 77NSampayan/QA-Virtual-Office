/**
 * Real-world requirement documents are markdown, not "REQ-1: text" lists. These fixtures reproduce the
 * layouts found in a sample BRD/FSD (fictional content): business requirements as a table, objectives
 * as bold bullets, functional requirements as bold or heading titles followed by numbered rules, rules
 * and acceptance criteria as tables.
 */
import { describe, expect, it } from 'vitest';
import { inferKind, parseRequirements } from '../src/qa.ts';

const DOC = `# Demo Store: BRD & FSD

Sample introduction paragraph.

## 2. Business context

### 2.1 Business objectives

- **OBJ-01** Let visitors browse and search the catalog without an account.
- **OBJ-02** Let registered customers buy online with card payment.

### 2.2 User roles

| Role | Description |
| --- | --- |
| Guest | Unauthenticated visitor |

## 3. Business requirements

| ID | Business requirement | Priority | Objective | Maps to |
| --- | --- | --- | --- | --- |
| BR-01 | Visitors can create an account with email and password | Must | OBJ-02 | FR-01 |
| BR-02 | Customers can log in, log out and reset a forgotten password | Must | OBJ-02 | FR-02, FR-03 |

## 4. Functional requirements (FSD)

### 4.1 Account and authentication

**FR-01 Registration** (Guest)

1. Page /register shows: First name, Last name, Email, Password.
2. All fields are mandatory.
3. Duplicate → "An account with this email already exists."

**FR-02 Login**

1. Page /login shows Email and Password.
2. Wrong email or password → "Invalid email or password."

#### FR-03 Logout

1. Logout ends the session.

### 4.2 Catalog

**BRL-01:** Passwords are 8–20 characters with upper case, lower case, a number and a special character.

| ID | Rule | Value |
| --- | --- | --- |
| NFR-01 | Pages load fast under normal load | 3 s at the 95th percentile |
| AC-01 | Given a guest on /register, when valid details are submitted, then an account is created | — |
`;

describe('parseRequirements: real-world markdown documents', () => {
  const r = parseRequirements(DOC);
  const byRef = (ref: string) => r.items.find((i) => i.ref === ref)!;

  it('finds every requirement in all the layouts, in document order', () => {
    expect(r.items.map((i) => i.ref)).toEqual(['OBJ-01', 'OBJ-02', 'BR-01', 'BR-02', 'FR-01', 'FR-02', 'FR-03', 'BRL-01', 'NFR-01', 'AC-01']);
    expect(r.duplicates).toEqual([]);
  });

  it('bold bullets: the ID is removed from the text and the bold markers are cleaned', () => {
    expect(byRef('OBJ-01')).toMatchObject({ title: 'Let visitors browse and search the catalog without an account.', text: 'Let visitors browse and search the catalog without an account.' });
  });

  it('table rows: the requirement text is the second cell; other columns become labelled lines', () => {
    const br = byRef('BR-01');
    expect(br.title).toBe('Visitors can create an account with email and password');
    expect(br.text).toBe('Visitors can create an account with email and password\nPriority: Must\nObjective: OBJ-02\nMaps to: FR-01');
  });

  it('table rows without an ID (role table, header rows, separators) are ignored, not imported', () => {
    expect(r.items.some((i) => ['Guest', 'Role', 'ID'].includes(i.ref))).toBe(false);
  });

  it('bold or heading titles take the following numbered rules as their text, up to the next requirement or heading', () => {
    const fr1 = byRef('FR-01');
    expect(fr1.title).toBe('Registration (Guest)');
    expect(fr1.text).toContain('1. Page /register shows: First name, Last name, Email, Password.');
    expect(fr1.text).toContain('3. Duplicate → "An account with this email already exists."');
    expect(fr1.text).not.toContain('Invalid email or password');
    expect(byRef('FR-02').text).toBe('Login\n1. Page /login shows Email and Password.\n2. Wrong email or password → "Invalid email or password."');
    expect(byRef('FR-03')).toMatchObject({ title: 'Logout', text: 'Logout\n1. Logout ends the session.' });
  });

  it('section headings end the previous requirement (their text does not leak into it)', () => {
    expect(byRef('FR-03').text).not.toContain('Catalog');
    expect(byRef('BR-02').text).not.toContain('Functional requirements');
  });

  it('"**BRL-01:** text" and table rows under other headings work too', () => {
    expect(byRef('BRL-01').text).toBe('Passwords are 8–20 characters with upper case, lower case, a number and a special character.');
    expect(byRef('NFR-01').text).toBe('Pages load fast under normal load\nValue: 3 s at the 95th percentile');
    expect(byRef('AC-01').text).toBe('Given a guest on /register, when valid details are submitted, then an account is created');
  });

  it('intro text before the first requirement is reported, text between requirements is not', () => {
    expect(r.unparsed).toContain('Sample introduction paragraph.');
    expect(r.unparsed.length).toBeLessThanOrEqual(5);
  });

  it('a requirement repeated later (e.g. in a traceability matrix) keeps the first, richer definition and is reported', () => {
    const again = parseRequirements(`${DOC}\n## 7. Traceability\n\n| Requirement | Test |\n| --- | --- |\n| BR-01 | TC-001 |\n`);
    expect(again.duplicates).toEqual(['BR-01']);
    expect(again.items.filter((i) => i.ref === 'BR-01')).toHaveLength(2);
  });

  it('still handles the simple line formats', () => {
    const s = parseRequirements('REQ-1: The system shall sign users in.\nUS-12 - As a user I want to reset my password.\nBRD 3.2) Payments confirm within 5 s.\n4.1 Orders over 100 need approval.');
    expect(s.items.map((i) => i.ref)).toEqual(['REQ-1', 'US-12', 'BRD 3.2', '4.1']);
  });
});

describe('table rows: choosing the requirement text from the right column', () => {
  const doc = [
    '| ID | Category | Requirement | How to verify |',
    '| --- | --- | --- | --- |',
    '| NFR-01 | Performance | Pages load in ≤ 3 s (95th percentile) | Lighthouse |',
    '',
    '| ID | Covers | Given | When | Then |',
    '| --- | --- | --- | --- | --- |',
    '| AC-01 | FR-01 | A guest is on /register | They submit valid details | An account is created |',
    '',
    '| ID | Statement | Owner |',
    '| --- | --- | --- |',
    '| BRL-05 | Orders over 100 need approval | Finance |',
  ].join('\n');
  const r = parseRequirements(doc);
  const get = (ref: string) => r.items.find((i) => i.ref === ref)!;

  it('prefers the column named like a requirement/statement over the first column', () => {
    expect(get('NFR-01').title).toBe('Pages load in ≤ 3 s (95th percentile)');
    expect(get('NFR-01').text).toBe('Pages load in ≤ 3 s (95th percentile)\nCategory: Performance\nHow to verify: Lighthouse');
    expect(get('BRL-05').title).toBe('Orders over 100 need approval');
  });

  it('Given / When / Then columns read as one sentence; the other columns stay as labelled lines', () => {
    expect(get('AC-01').title).toBe('Given A guest is on /register, when They submit valid details, then An account is created');
    expect(get('AC-01').text).toBe('Given A guest is on /register, when They submit valid details, then An account is created\nCovers: FR-01');
  });
});

describe('inferKind: document kind from the reference prefix', () => {
  it.each([
    ['BR-01', 'brd'],
    ['BRL-03', 'brd'],
    ['OBJ-02', 'brd'],
    ['FR-12', 'fsd'],
    ['NFR-07', 'fsd'],
    ['VR-14', 'fsd'],
    ['AC-04', 'acceptance_criteria'],
    ['US-9', 'user_story'],
    ['REQ-1', 'other'],
    ['4.1', 'other'],
  ])('%s -> %s', (ref, kind) => expect(inferKind(ref)).toBe(kind));
});
