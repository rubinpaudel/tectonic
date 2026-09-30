# Fictional Nike Belgium evidence

This dataset simulates SD Worx servicing Nike Belgium. Every person, contact,
address, amount, policy and workplace event is fictional. Email addresses use
reserved `.example` domains. Address strings explicitly say `(synthetic)`.

There are **50 employees**, **80 source files**, and **64 Teams messages**:

| Directory | Source format | Count |
| --- | --- | ---: |
| `gmail/` | Text email export | 26 |
| `sharepoint/` | Text-extractable PDF | 51 |
| `teams/` | JSON channel export | 3 |

## The fragmented Abel narrative

1. `sharepoint/employee-EMP-001-abel.pdf` is a **2026-09-01 snapshot**. Abel
   works for Nike Belgium, has monthly base salary **EUR 1800**, bicycle
   compensation **EUR 50**, a **5 km one-way** bicycle commute and the old
   address **14 Lantern Lane, 1000 Brussels (synthetic)**.
2. `gmail/2026-09-21-abel-address-change.txt` is Abel's notification to HR.
   He moved effective **2026-09-20** to **82 Meadow Crescent, 3000 Leuven
   (synthetic)**. He reports a regular bicycle commute of approximately **15 km
   one-way**, about **10 km longer**. This email contains no salary, compensation
   policy, HR acknowledgment or subsequent issue.
3. `teams/hr-payroll-september.json` mixes 24 unrelated messages with four
   relevant messages. On **2026-09-22**, HR acknowledges the move and then makes
   a separate commitment to update the dossier and pass the change to SD Worx.
   On **2026-09-28**, a payroller reports that the dossier still shows the old
   address and **EUR 50**, and cannot find confirmation of processing. HR also
   cannot yet confirm processing. This is an **open, uncertain issue**; neither
   message proves what was ultimately paid.
4. `sharepoint/mobility-policy-2026-09.pdf` is separate policy context,
   effective **2026-09-01**. Regular one-way bicycle commute bands are **0-9.9 km:
   EUR 50/month**, and **>=10 km: EUR 80/month**. It contains no individual case.

Combining these sources supports a **potential EUR 30 monthly discrepancy**.
It does not prove an underpayment or a completed correction. No source includes
the complete narrative. The other 49 dossiers, 25 unrelated emails and 60
unrelated Teams messages make raw evidence retrieval realistically noisy.

The new address is current from 2026-09-20. The old address remains historical;
the unprocessed administrative snapshot must not make it equally current. Keep
source-version evidence after supersession. A promise to update the dossier is
different from a confirmed update or resolution.

## Source formats and identity

Dossier filenames are `sharepoint/employee-EMP-NNN-<name-slug>.pdf`.
Each uses plain, predictable `key: value` rows:

```text
Employee ID: EMP-001
Entity ID: nike:employee:abel
Name: Abel
Email: abel@nike.example
Teams user ID: nike:teams:abel
Employer: Nike Belgium
Department: Retail operations
Location: Brussels
Address: 14 Lantern Lane, 1000 Brussels (synthetic)
Base salary: EUR 1800 / month
Bicycle compensation: EUR 50 / month
Bicycle commute one-way: 5 km
Snapshot date: 2026-09-01
Employment start date: 2021-01-01
```

The PDFs use selectable text, uncompressed content streams and built-in
Helvetica fonts. They have no timestamps, random identifiers or dependencies in
their generator. All monetary labels spell out `EUR` to avoid encoding ambiguity.

Gmail exports have `From`, `To`, ISO UTC `Date`, `Message-ID`, `Subject`,
`Employee-ID` and `Content-Type` headers, a blank line, then ordinary human prose.
The stable move message ID is `nike-gmail-abel-move-20260921@nike.example`.

Teams exports have this shape:

```json
{
  "tenantId": "nike",
  "team": "Nike Belgium / People Services",
  "channel": { "id": "nike:channel:hr-payroll", "displayName": "HR and payroll handover" },
  "exportedAt": "2026-09-30T12:00:00Z",
  "messages": [{
    "id": "nike-teams-abel-ack-20260922",
    "createdDateTime": "2026-09-22T08:40:00Z",
    "from": { "id": "nike:teams:sarah-van-doren", "displayName": "Sarah Van Doren", "email": "sarah.van.doren@nike.example" },
    "employeeId": "EMP-001",
    "body": { "contentType": "text", "content": "Human prose" },
    "mentions": [{ "id": "nike:teams:abel", "displayName": "Abel", "email": "abel@nike.example" }]
  }]
}
```

`from` identifies the **actor**, while `employeeId` and `mentions` identify the
**affected employee** in the HR handover messages. Do not bind Sarah's or the
payroller's email to Abel. Other channels are
`teams/retail-operations-september.json` and `teams/benefits-september.json`.
Messages are sorted chronologically and IDs are globally unique within Nike.

Abel's canonical entity is `nike:employee:abel`. Resolve the name `Abel`, email
`abel@nike.example`, employee ID `EMP-001` and Teams ID `nike:teams:abel` to it.
The roster uses stable IDs `EMP-001` through `EMP-050`, with canonical entity IDs
and Teams IDs derived from name slugs. All 50 employees appear in dossier PDFs.

## Acceptance-only files: never ingest

**Scan only approved source extensions inside `gmail/`, `sharepoint/` and
`teams/`.** The files below are outside those directories deliberately:

- `expected-memory.json`: semantic acceptance oracle, including all 50 employee
  identities, Abel's 14 expected memory items, evidence paths/message locators,
  effective dates, expected relationships and the primary demo assertions.
- `manifest.json`: deterministic source-file inventory with byte lengths and
  SHA-256 hashes. It is generator metadata, not evidence.
- `README.md`: narrative and reproduction instructions, not evidence.

Oracle source paths are relative to `mock-data/nike/`. `expectedMemories[].key`
is an acceptance label, not a mandatory database or canonical memory key.
`value` describes the expected semantics; implementations may map these to
flexible `Memory.content`. `acceptableTypes`/`acceptableStatuses` allow equivalent
semantic representations while retaining uncertainty. Evidence locators use the
real email or Teams message IDs. `expectedRelations` expresses semantic links;
the new-to-old `supersedes` direction and historical address status are required.

## Reproduce and validate

Use Node 22. The generator and Node tests require **no npm dependency additions**.
From the repository root:

```sh
pnpm exec node scripts/mock-data/generate.mjs
pnpm exec node scripts/mock-data/generate.mjs --check
pnpm exec node --test scripts/mock-data/generate.test.mjs
```

In an isolated checkout without installed workspace dependencies, use
`pnpm --config.verify-deps-before-run=false exec node ...` to prevent pnpm's
automatic workspace installation. The fixture commands use Node built-ins only.

The generator rewrites only its 82 known output files. It neither deletes other
files nor edits this README. `--check` is read-only and compares every generated
byte. `--out /absolute/directory` generates an independent copy for experiments;
the normal dataset remains a frozen evidence snapshot. To exercise source
versioning later, change one source in such a copy and preserve the previous
snapshot in the repository layer.

For independent PDF extraction and clipping verification, use Python with
`pypdf` and `pdfplumber`:

```sh
python3 scripts/mock-data/validate_pdf_text.py
```

Poppler's `pdftotext` is included automatically when it is on `PATH`; pass
`--pdftotext /absolute/path/to/pdftotext` to select it explicitly. `--node` selects
a Node executable if needed. The validator checks all rows in all 51 PDFs,
single-page structure, the synthetic footer and every rendered glyph's bounds.
It does not write inside the dataset. Python PDF libraries and Poppler are
validation tools only; fixture generation remains dependency-free.
