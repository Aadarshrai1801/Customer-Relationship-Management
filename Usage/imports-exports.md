# Imports & Exports – Comprehensive Testing Guide

Base URLs: API `http://localhost:3001`, Web `http://localhost:3000`.

## 1. Overview

This guide covers Async CSV Import Wizard (upload → mapping → preview → dry-run → progress → email notify), 50k-row non-blocking imports, field-mapping templates, VCF import, bulk operations, and CSV exports. Imports run as background jobs so the UI never blocks; users get live progress plus email notification on completion with success/error summary and downloadable error file.

Scope:

- Import objects: Contacts, Accounts, Leads, Deals (Contacts primary for this guide).
- Wizard steps: 1 Upload, 2 Mapping, 3 Preview, 4 Dry-run validation, 5 Confirm & Run, 6 Progress + Done + Email.
- Mapping: auto-detect headers, manual column→field map, save/reuse field-mapping template, required-field enforcement, picklist/custom-field mapping.
- Dry-run: validates all rows without writing, returns per-row errors + summary.
- Execution: chunked BullMQ job (e.g., 500 rows/batch), progress websocket/polling, cancel, retry-failed-only.
- 50k-row SLO: upload accepted in <10s, UI responsive during job, job completes, progress accurate.
- VCF: single `.vcf` with multiple `VCARD`s → contacts.
- Bulk ops: bulk edit / bulk delete / bulk assign from list or from import batch.
- Exports: filtered list → async CSV export with email link for large sets.

Out of scope: Excel `.xlsx` (if unsupported, must error clearly), real-time sync integrations.

## 2. Prerequisites & Test Data Setup

### 2.1 Environment

- API `http://localhost:3001`, Web `http://localhost:3000`.
- Object storage or local `./uploads` writable; Email (SMTP/Mailhog) configured to capture notify emails at `http://localhost:8025` if Mailhog.
- Test users: `admin@test.com / Admin123!` (can import/export/delete), `rep@test.com / Rep123!` (import allowed, bulk delete denied).
- Limits: `MAX_IMPORT_ROWS=50000`, `MAX_FILE_MB=20`, allowed `text/csv, text/vcard`.
- Clean org `test-import-org`; record baseline counts: `GET /api/contacts/count`.

### 2.2 Sample CSV files (create in `C:\Temp\imports\`)

**valid-10.csv** (happy path):

```csv
firstName,lastName,email,phone,accountName,title,ownerEmail
Ava,Stone,ava.stone@example.com,+1-415-555-0101,Acme Inc,AE,admin@test.com
Liam,Reed,liam.reed@example.com,+1-415-555-0102,Acme Inc,SDR,rep@test.com
Mia,Chen,mia.chen@example.com,+1-415-555-0103,Globex,Manager,admin@test.com
Noah,Patel,noah.patel@example.com,+1-415-555-0104,Globex,VP,admin@test.com
Emma,Wilson,emma.wilson@example.com,+1-415-555-0105,Initech,CEO,rep@test.com
Olivia,Brown,olivia.brown@example.com,+1-415-555-0106,Initech,CTO,admin@test.com
Ethan,Davis,ethan.davis@example.com,+1-415-555-0107,Umbrella,Analyst,admin@test.com
Sophia,Moore,sophia.moore@example.com,+1-415-555-0108,Umbrella,Director,rep@test.com
Lucas,Taylor,lucas.taylor@example.com,+1-415-555-0109,Hooli,Engineer,admin@test.com
Amelia,Anderson,amelia.anderson@example.com,+1-415-555-0110,Hooli,Designer,admin@test.com
```

**dryrun-errors.csv** (6 rows, 4 should fail dry-run):

```csv
firstName,lastName,email,phone,accountName,title
Bad,,bad-email,not-a-phone,Acme Inc,AE
,NoLast,missing-first@example.com,+1-415-555-0200,Acme,SDR
Dup,Person,ava.stone@example.com,+1-415-555-0101,Acme,AE
Long,Name,toolongemailaddress_that_exceeds_the_maximum_allowed_length_for_email_fields_in_this_crm_system_123456789@example.com,+1-415-555-0203,Acme,AE
Good,Guy,good.guy@example.com,+1-415-555-0204,Acme,AE
BadPicklist,Test,bad.pick@example.com,+1-415-555-0205,Acme,NOT_A_REAL_TITLE
```

**mapping-test.csv** (weird headers to test mapping + template):

```csv
FName,LName,E-mail,Phone Number,Company,Job Title
Zoe,Zimmerman,zoe.z@example.com,4155550301,Zeta Corp,Founder
Yan,Young,yan.y@example.com,4155550302,Zeta Corp,Co-Founder
```

**big-50k.csv** – generate:

```bash
python3 -c "print('firstName,lastName,email,phone,accountName'); [print(f'Bulk{i},User{i},bulk{i}@load.test,+1415555{i:04d},LoadCo') for i in range(50000)]" > big-50k.csv
```

**sample.vcf**:

```
BEGIN:VCARD
VERSION:3.0
FN:Carlos VCF
N:VCF;Carlos;;;
EMAIL:carlos.vcf@example.com
TEL;TYPE=CELL:+1-415-555-0401
ORG:VCF Corp
TITLE:Tester
END:VCARD
BEGIN:VCARD
VERSION:3.0
FN:Dana VCF
N:VCF;Dana;;;
EMAIL:dana.vcf@example.com
TEL;TYPE=WORK:+1-415-555-0402
ORG:VCF Corp
END:VCARD
```

### 2.3 Field-mapping template seed

- Pre-save template `Standard Contact Map`: FName→firstName, LName→lastName, E-mail→email, Phone Number→phone, Company→accountName, Job Title→title. Used in TC-08.

### 2.4 Email notify capture

- Set user email to Mailhog inbox; verify SMTP env `SMTP_HOST=localhost SMTP_PORT=1025`.
- For manual test, use `admin@test.com` and check Mailhog after import done.

## 3. Test Environment Matrix

| Dimension   | Variants                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| Browser     | Chrome 126, Firefox 128, Safari 17                                                                         |
| File size   | 10 rows, 1k rows, 10k rows, 50k rows                                                                       |
| File type   | CSV UTF-8, CSV with BOM, CSV semicolon-delimited, VCF 3.0/4.0                                              |
| Encoding    | UTF-8, Latin-1 (accented names José Niño), emoji in notes                                                  |
| Role        | Admin (all), Rep (import yes / bulk-delete no), Read-only (no import)                                      |
| Network     | Normal, slow 3G upload (progress + resumable? at least no freeze), disconnect mid-progress (poll recovers) |
| Concurrency | 2 imports at once, import during nightly dedup job                                                         |
| Email       | SMTP up vs down (job still succeeds, notify queued/retried)                                                |
| Export size | 100 rows inline download vs 20k rows async email link                                                      |

SLOs: 10-row import E2E <30s; 50k import job <15 min, UI interactive throughout (INP <300ms); dry-run 1k rows <10s; export 20k <2 min.

## 4. Detailed Step-by-Step Test Cases (at least 20 numbered TC cases)

### TC-01: Happy-path CSV wizard E2E (10 rows)

Steps:

1. Go to `http://localhost:3000/contacts` → Import → Upload `valid-10.csv`.
2. Verify Step 2 Mapping auto-maps all 7 columns (green checks), no unmapped required.
3. Step 3 Preview: verify 10-row table, emails lowercased preview, phones formatted.
4. Step 4 Dry-run: Run → expect `10 valid, 0 errors`.
5. Step 5 Confirm: keep `Skip duplicates by email`, click Start Import.
6. Step 6 Progress: bar 0→100%, counts `processed/total`, ETA, Cancel hidden after done; toast + row in Import History.
7. Verify 10 contacts searchable; open one, fields correct, `source=import:batchId`.
   Expected: All 10 created, history entry `completed`, email notify received.

### TC-02: Mapping – manual fix + required enforcement

Steps:

1. Upload `mapping-test.csv` (headers FName etc.).
2. Verify auto-map suggests FName→firstName etc. but `E-mail` unmapped (hyphen) – manually map to `email`.
3. Unmap required `email` → Try Next → blocked with “Email is required”.
4. Re-map, proceed.
   Expected: Block message, Next disabled until required mapped; mapping state persists on Back.

### TC-03: Preview pagination + value transforms

Steps:

1. In Preview, verify phone `4155550301` previewed as `+1-415-555-0301`, email trimmed/lowercased.
2. Paginate / search preview for `zoe.z@example.com`.
   Expected: Transforms shown with “will be normalized” hint; no write yet (DB count unchanged).

### TC-04: Dry-run error cases (CRITICAL – sample rows)

Steps:

1. Upload `dryrun-errors.csv`, map, Preview, Run dry-run.
2. Verify summary: `2 valid (Good Guy + ?), 4 errors` with per-row table:
   - Row 2 `Bad / bad-email`: errors `email invalid`, `lastName required`, `phone invalid`.
   - Row 3 missing firstName: `firstName required`.
   - Row 4 Dup ava.stone: `duplicate email (existing)` warning (if skip-dups on → info not error; if dedup-strict → error – verify per setting).
   - Row 5超长 email: `email max length`.
   - Row 7 BadPicklist title: `title must be one of [AE,SDR,...]` or auto-create? Verify per spec (should error).
3. Download error CSV, verify it contains `rowNumber, rawData, errors[]`.
4. Fix file (remove bad rows), re-upload → dry-run clean.
   Expected: No rows written during dry-run (count unchanged); errors human-readable with column names; error file downloadable.

### TC-05: Confirm options – skip vs update duplicates

Steps:

1. Re-import `valid-10.csv` with option `Skip duplicates` → expect `0 created, 10 skipped`.
2. Re-import with `Update existing by email` + change title for ava.stone in file → verify title updated, `updated` count 10.
   Expected: Counts accurate; audit shows `contact.updated via import`.

### TC-06: Async progress + non-blocking UI (50k-row test)

Steps:

1. Upload `big-50k.csv` (or 10k if time-boxed; note size in result).
2. Start import, immediately navigate: open Deals, search contacts, create a contact manually – all must stay responsive.
3. Watch progress: `/imports/:jobId` polls every 2s, bar + `processed/total/failed`, throughput rows/sec, ETA.
4. Verify browser Back/refresh → progress resumes (jobId in URL `?import=jobId`).
   Expected: No frozen UI, no 504; manual contact creation succeeds mid-job; final counts match.

### TC-07: Email notify on completion

Steps:

1. With valid-10 import, wait for Done.
2. Check Mailhog/inbox for subject `[CRM] Import complete: valid-10.csv – 10 created, 0 failed`.
3. Click link in email → opens Import Detail page.
4. Disable SMTP (stop Mailhog), run another small import → job still completes, notify status `retry_queued`, banner “Email failed – download results here”.
   Expected: Email contains summary + error-file link + batchId; SMTP-down doesn’t fail import.

### TC-08: Field-mapping template save/reuse

Steps:

1. After mapping `mapping-test.csv`, Save as template `Zeta Map`.
2. New import same file → Apply template `Zeta Map` → all mapped instantly.
3. Admin deletes template → verify gone for all, in-use imports unaffected.
4. Rep cannot delete admin’s shared template (403) but can use it.
   Expected: Template CRUD + share scope (private/shared); mapping applied <1s.

### TC-09: VCF import

Steps:

1. Import → Upload `sample.vcf`.
2. Verify detected `2 contacts`, mapping auto (FN→name split, EMAIL, TEL, ORG).
3. Dry-run clean, Run → verify Carlos + Dana created with phones.
4. Upload malformed `.vcf` (missing END:VCARD) → clear error “Invalid VCF at card 1”.
   Expected: Both created; malformed rejected pre-mapping with line number.

### TC-10: Import validation – file type/size/encoding

Steps:

1. Upload `.xlsx` → rejected “Only CSV/VCF allowed”.
2. Upload 25MB CSV (>20MB) → rejected before upload completes with size message.
3. Upload Latin-1 `José,Niño` file → correctly decoded (no mojibake) or explicit encoding picker appears.
4. Upload empty CSV / header-only → “No data rows”.
   Expected: All rejections with actionable messages, no 500.

### TC-11: Cancel import mid-run

Steps:

1. Start 10k import, click Cancel at ~30%.
2. Verify status `cancelled`, processed rows remain (partial commit per chunk), `remaining` discarded, audit entry.
3. Retry-failed-only / Resume? Verify Resume continues from checkpoint (if supported) else new job for remainder.
   Expected: Cancel <5s, counts honest (`created 3000, cancelled, 7000 not processed`).

### TC-12: Retry-failed-only with corrected file

Steps:

1. Import file with 3 bad rows (from TC-04 fixed to 1 bad), complete with `2 failed`.
2. Download error CSV, fix emails, use Retry → upload fixed error file linked to same batch.
3. Verify failed→0, batch status `completed_with_retry`.
   Expected: Only failed rows retried, no duplicates of successes.

### TC-13: Bulk ops – bulk assign + bulk edit from list

Steps:

1. In Contacts list, filter `accountName=Acme Inc`, select all 5, Bulk Assign owner→`rep@test.com`, Bulk Edit title→`AE`.
2. Verify all updated, audit bulk entry, undo? (if supported, test Undo within 30s).
   Expected: Single bulk job, progress toast, <5s for 500.

### TC-14: Bulk delete guard + permissions

Steps:

1. As Rep, select 3 contacts incl. one with open deal → Bulk Delete → expect per-row result: 2 deleted, 1 blocked `has_open_deal` with reason; Rep bulk-delete of 500 → 403 if role denies.
2. As Admin, bulk delete with typed confirm + reassign deals.
   Expected: Partial success table, no silent skip; permission enforced.

### TC-15: Export CSV – small inline vs large async

Steps:

1. Filter contacts `account=Acme`, Export → small (<5k) downloads immediately `contacts_export_*.csv` with correct headers + UTF-8 BOM for Excel.
2. Export all (or 20k seeded) → async: toast “Export queued – you’ll be emailed”, job in Exports list, email with download link (expiry 7d).
3. Verify exported CSV re-imports cleanly (round-trip).
   Expected: Filenames timestamped, columns match field order + custom fields, dates ISO.

### TC-16: Export permissions + field-level redaction

Steps:

1. As Rep (no `contacts.export_email`? or PII restricted), export → emails masked or blocked per policy; verify per spec.
2. Read-only user Export button hidden; direct API `GET /api/exports` → 403.
   Expected: Policy enforced, audit `export.created` with row count.

### TC-17: Import history page + detail

Steps:

1. Go to `/settings/imports` (or `/contacts/imports`), verify columns: File, Object, By, Started, Duration, Total/Created/Updated/Skipped/Failed, Status, Actions (View, Error file, Retry, Delete record).
2. Open detail for TC-01 batch: row-level table with status per row + search failed only.
   Expected: Pagination, filters, retention (90d), delete history doesn’t delete contacts.

### TC-18: Concurrency – two imports + dedup race

Steps:

1. Start two 1k imports simultaneously with overlapping emails.
2. Verify both complete, duplicates handled per option (second’s dups skipped, no 500), dedup queue shows new medium candidates if names similar.
   Expected: No deadlock, unique-email constraint holds, job isolation.

### TC-19: Performance – dry-run 1k <10s, import 1k <2 min

Steps:

1. Time dry-run + import of generated 1k CSV; record durations, API p95, worker CPU.
2. Verify progress ETA accuracy within 30%.
   Expected: Meets SLOs; log evidence.

### TC-20: Accessibility + wizard UX

Steps:

1. Keyboard-only through wizard (Tab/Enter), screen-reader labels on mapping selects, focus returns on Back.
2. 375px mobile: mapping table → stacked cards, progress bar visible.
3. Reload mid-wizard (Step 3) → draft restored from localStorage/server draft.
   Expected: No trap, draft resumes, aria-live on progress %.

### TC-21: Security – CSV injection + XSS

Steps:

1. Import row with `=CMD('calc')!A1`, `+1+2`, `@SUM`, `<script>alert(1)</script>` in name/title.
2. Verify export escapes (`'=CMD...` with leading `'`), UI renders as text (no script exec), API stores raw but sanitizes on render.
   Expected: No formula exec in Excel (prefix `'`), no stored XSS.

### TC-22: Org isolation

Steps:

1. Import as org A, login as org B → zero new contacts, history empty, template list empty.
2. Attempt `GET /api/imports/:jobIdOfOrgA` as org B → 404 (not 403 leak).
   Expected: Strict isolation.

## 5. API Testing Section

| Method & Endpoint                                              | Purpose                        | Auth   | Expected                                                 |
| -------------------------------------------------------------- | ------------------------------ | ------ | -------------------------------------------------------- |
| `POST /api/imports/presign` or `multipart /api/imports/upload` | Upload file, get `fileId`      | Bearer | 201 `{fileId, rowsDetected, headers[]}`                  |
| `POST /api/imports/dry-run`                                    | Validate without write         | Bearer | 200 `{valid, invalid, errors:[{row, column, message}]}`  |
| `POST /api/imports`                                            | Start job with mapping+options | Bearer | 202 `{jobId, batchId}`                                   |
| `GET /api/imports/:jobId`                                      | Poll progress                  | Bearer | 200 `{status, processed, total, failed, etaSec}`         |
| `POST /api/imports/:jobId/cancel`                              | Cancel                         | Bearer | 200 `{status:cancelled}`                                 |
| `POST /api/imports/:jobId/retry`                               | Retry failed                   | Bearer | 202 new jobId                                            |
| `GET /api/import-templates` / `POST` / `DELETE`                | Mapping templates              | Bearer | 200/201/204                                              |
| `POST /api/exports`                                            | Request export                 | Bearer | 202 `{exportId}` + `GET /api/exports/:id` + download URL |
| `POST /api/vcf/import` or same `/api/imports` with vcf         | VCF path                       | Bearer | 202                                                      |
| `POST /api/contacts/bulk`                                      | Bulk edit/assign/delete        | Bearer | 200 `{succeeded, failed:[{id, reason}]}`                 |

### curl examples (API http://localhost:3001)

```bash
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@test.com","password":"Admin123!"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

# 1) Upload CSV (multipart)
curl -s -X POST http://localhost:3001/api/imports/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@valid-10.csv;type=text/csv" -F "objectType=contact" | python3 -m json.tool
# -> {fileId:"file_abc", headers:[...], rowCount:10}

# 2) Dry-run with mapping
curl -s -X POST http://localhost:3001/api/imports/dry-run \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "fileId":"file_abc",
    "objectType":"contact",
    "mapping":{"firstName":"firstName","lastName":"lastName","email":"email","phone":"phone","accountName":"accountName","title":"title"},
    "options":{"skipDuplicates":true,"dedupeKey":"email"}
  }' | python3 -m json.tool
# expect valid/invalid + per-row errors for dryrun-errors.csv case

# 3) Start import job
curl -s -X POST http://localhost:3001/api/imports \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"fileId":"file_abc","objectType":"contact","mapping":{},"options":{"skipDuplicates":true},"templateName":"Standard Contact Map"}' | python3 -m json.tool

# 4) Poll progress
JOB="job_xyz"
curl -s http://localhost:3001/api/imports/$JOB -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
# poll until status=completed; check processed==total

# 5) Cancel
curl -s -X POST http://localhost:3001/api/imports/$JOB/cancel -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# 6) Request export (filtered)
curl -s -X POST http://localhost:3001/api/exports \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"objectType":"contact","format":"csv","filters":{"accountName":"Acme Inc"},"columns":["firstName","lastName","email","phone","accountName"]}' | python3 -m json.tool
curl -s http://localhost:3001/api/exports/exp_123 -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# 7) Bulk assign
curl -s -X POST http://localhost:3001/api/contacts/bulk \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"ids":["c1","c2","c3"],"action":"assign","ownerId":"rep_user_id"}' | python3 -m json.tool

# 8) Templates CRUD
curl -s http://localhost:3001/api/import-templates -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
curl -s -X POST http://localhost:3001/api/import-templates \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Zeta Map","objectType":"contact","mapping":{"FName":"firstName","LName":"lastName"}}' | python3 -m json.tool
```

Negative: upload `.exe` → 415; dry-run missing required map → 422; `GET /imports/:otherOrgJob` → 404; bulk delete without confirm → 422; export 100k rows without async → 202 queued not 200 inline.

## 6. UI Testing Section

Routes: `/contacts/import` (wizard), `/contacts/imports` or `/settings/imports` (history), `/contacts` (bulk bar), `/contacts/export` modal.

Checklist:

- Wizard stepper (1 Upload drag-drop + browse, file chip with size/rows; 2 Mapping table Source→Target selects + Auto-map + Unmapped warnings + Save template; 3 Preview table 10 rows + transforms hint; 4 Dry-run Run button + summary donut + error table + Download errors; 5 Options radios Skip/Update + ack + Start; 6 Progress bar + counts + ETA + View results + email note).
- Drag-drop highlight, invalid-file shake + message, large-file “This will run in background” hint.
- Mapping: sticky header, search columns, required asterisk, duplicate-target warning (“email mapped twice”), template dropdown Apply/Save.
- Preview: virtualized for 1k preview (first 100 only + “showing 100 of X”), normalized badges.
- Dry-run errors: red row highlight, column-level messages, filter “Errors only” toggle, copy error button.
- Progress: animated bar, live counts via polling/WS, pause?/Cancel, refresh-safe (jobId URL), Done confetti? + summary cards + links to created list (`/contacts?importBatch=xxx`) + error file.
- History: status pills (queued/running/completed/failed/cancelled), duration, actions; empty state illustration.
- Bulk bar: `N selected – Assign/Edit/Delete/Export`, confirm modals, partial-result modal.
- Export modal: column picker (checkboxes + Select all + custom fields), filter summary, format CSV, row-count estimate, `Export` → immediate download vs queued toast.
- Toasts + email deep-link; mobile stacking; keyboard nav; aria-live progress.

Visual regression: snapshot wizard steps, progress 50%, error table.

## 7. Regression & Cross-Feature Impact

| Area                     | Impact                                                                                                                 | Retest                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Dedup                    | Imports create dups → queue spike; skip-dups option                                                                    | Import dup file, check `/contacts/duplicates` + on-create check perf       |
| Validation/Custom fields | Required custom field missing in file → dry-run error                                                                  | Add required custom `Industry`, import without it → error                  |
| Workflows                | Import triggers `contact.created` workflows per row? (should be batched/debounced or opt-out `triggerWorkflows:false`) | Check workflow run count, email flood guard                                |
| Search/Index             | 50k bulk insert → search index lag                                                                                     | Search new bulk email immediately + after 60s; check Elasticsearch/Trigram |
| Reports/Dashboards       | Counts jump                                                                                                            | Dashboard totals, funnel                                                   |
| Audit                    | Bulk import single audit batch entry (not 50k rows)                                                                    | Audit log shows `import.completed` with counts                             |
| Permissions              | Rep import vs delete                                                                                                   | Rep matrix retest                                                          |
| Storage/Quotas           | File + row quotas per plan                                                                                             | Exceed free-plan 1k limit → 402 upgrade prompt                             |
| Webhooks                 | `contact.created` burst                                                                                                | Webhook receiver 429 handling, retry                                       |
| Exports+PII              | Masking rules                                                                                                          | Export after privacy-settings change                                       |

Run `duplicates-merge`, `custom-fields`, `privacy-gdpr` smoke after import changes.

## 8. Expected Results Summary Table

| TC    | Feature          | Input                      | Expected                            | Pass Criteria                               |
| ----- | ---------------- | -------------------------- | ----------------------------------- | ------------------------------------------- |
| TC-01 | Wizard happy     | valid-10.csv               | 10 created, email received          | Search finds all, history completed         |
| TC-02 | Mapping          | Weird headers              | Manual map + required block         | Next blocked until fixed                    |
| TC-03 | Preview          | Phones                     | Normalized preview, no write        | DB count unchanged                          |
| TC-04 | Dry-run errors   | 6-row bad file             | 4 errors detailed + error CSV       | Zero writes, messages clear                 |
| TC-05 | Skip vs Update   | Re-import                  | 10 skipped / 10 updated             | Counts + audit                              |
| TC-06 | 50k non-block    | big-50k                    | UI responsive, job completes        | INP ok, counts match                        |
| TC-07 | Email notify     | Done                       | Subject + link                      | Mailhog has mail; SMTP-down still completes |
| TC-08 | Template         | Zeta Map                   | Save/reuse/delete + perms           | <1s apply                                   |
| TC-09 | VCF              | 2 cards                    | 2 created; malformed rejected       | Fields correct                              |
| TC-10 | File guards      | xlsx/25MB/Latin-1/empty    | 4 rejections/messages               | No 500                                      |
| TC-11 | Cancel           | 10k at 30%                 | cancelled + partial honest          | <5s                                         |
| TC-12 | Retry failed     | Fix + retry                | Only failed retried                 | No dup successes                            |
| TC-13 | Bulk edit/assign | 5 Acme                     | All updated                         | <5s                                         |
| TC-14 | Bulk delete      | With open deal + Rep 403   | Partial + guard                     | No silent loss                              |
| TC-15 | Export           | Small inline / large async | Immediate vs email link; round-trip | BOM + ISO dates                             |
| TC-16 | Export perms     | Rep masked                 | Masked/blocked + audit              | 403 direct                                  |
| TC-17 | History          | Detail page                | Row-level statuses                  | Pagination                                  |
| TC-18 | Concurrency      | 2×1k overlap               | No deadlock, dups skipped           | Unique holds                                |
| TC-19 | Perf             | 1k timings                 | Dry <10s, import <2min              | Logged                                      |
| TC-20 | A11y/draft       | Keyboard/mobile/reload     | Trap-free, resumes                  | aria-live                                   |
| TC-21 | Injection/XSS    | `=CMD` + script            | Escaped, no exec                    | Excel safe                                  |
| TC-22 | Isolation        | Org B                      | Zero leak, 404                      | Strict                                      |

## 9. Troubleshooting & Common Failures

| Symptom                             | Cause                                                             | Fix                                                                          |
| ----------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Upload 413/500                      | File >MAX_FILE_MB or Nginx `client_max_body_size` small           | Check `MAX_FILE_MB`, Nginx config, chunk upload; compress/split              |
| Headers garbled (ï»¿)               | BOM not stripped                                                  | Ensure parser strips BOM; re-save UTF-8; verify preview                      |
| Mojibake José                       | Latin-1 vs UTF-8 mis-detect                                       | Re-save UTF-8 or use encoding picker; check `chardet` log                    |
| Dry-run 0 rows                      | Wrong delimiter (semicolon) or empty lines                        | Set delimiter in wizard, trim empty; check `rowCount` from upload response   |
| Dry-run passes but import fails row | Race (dup created mid-job) or required custom added after dry-run | Use Retry-failed, re-run dry-run; check worker logs `logs/import.log`        |
| Progress stuck at X%                | Worker crashed / Redis down / job lost                            | `GET /imports/:job` status, worker logs, `docker compose ps redis`, requeue  |
| Email not received                  | SMTP down / spam / wrong to-address                               | Check Mailhog `8025`, `EXPORT_MAIL_FROM`, job `notifyStatus`, spam           |
| 50k job OOM/timeout                 | Chunk too large, no streaming parse                               | Lower `IMPORT_CHUNK=500`, stream parser, increase worker memory              |
| Duplicate emails created            | `skipDuplicates:false` + no unique index, or concurrent race      | Enforce DB unique partial index on `(org_id, lower(email))`, use update mode |
| Export dates wrong TZ               | UTC vs local render                                               | Expect ISO UTC in CSV; UI converts; verify `2026-09-08T...Z`                 |
| VCF missing phones                  | `TEL;TYPE=` variants unhandled                                    | Check parser supports `CELL/WORK/VOICE`; log raw VCARD                       |
| Bulk partial with no reason         | Frontend swallows per-row errors                                  | Inspect `POST /contacts/bulk` response `failed[]`, include requestId in bug  |
| Template not applying               | Header case change / extra spaces                                 | Trim/case-insensitive match; re-save template; check shared scope            |

Debug: Network tab `upload/dry-run/imports/:job` payloads; worker `logs/import.log`; `SELECT status, COUNT(*) FROM import_rows WHERE job_id='...'`; Mailhog UI.

## 10. Pass/Fail Checklist

- [ ] TC-01 10-row wizard E2E + email + history completed
- [ ] TC-02 Manual mapping + required block
- [ ] TC-03 Preview transforms, zero writes pre-run
- [ ] TC-04 Dry-run 4 errors detailed + error CSV downloadable
- [ ] TC-05 Skip (10 skipped) + Update (10 updated)
- [ ] TC-06 50k (or 10k) non-blocking, refresh-safe progress
- [ ] TC-07 Email subject/counts/link; SMTP-down still completes
- [ ] TC-08 Template save/reuse/delete + perms
- [ ] TC-09 VCF 2 created + malformed line-number error
- [ ] TC-10 xlsx/size/encoding/empty rejections, no 500
- [ ] TC-11 Cancel <5s with honest partial counts
- [ ] TC-12 Retry-failed-only no dup successes
- [ ] TC-13 Bulk assign/edit <5s
- [ ] TC-14 Bulk delete guard + Rep 403
- [ ] TC-15 Small inline vs large async export + round-trip re-import
- [ ] TC-16 Export masking + 403 direct
- [ ] TC-17 History detail row-level + pagination
- [ ] TC-18 Concurrent imports no deadlock
- [ ] TC-19 Perf SLOs logged
- [ ] TC-20 Keyboard/mobile/draft-resume
- [ ] TC-21 CSV injection escaped, no XSS
- [ ] TC-22 Org isolation 404
- [ ] curl 1–8 expected codes
- [ ] Regression: dedup queue, workflows, search, reports intact
- [ ] No console errors; DB counts reconcile (`contacts` delta == created - deleted)

Sign-off: Tester __________ Date __________ File sizes tested __________ Build __________
