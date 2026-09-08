# Duplicates & Merge – Comprehensive Testing Guide

Base URLs: API `http://localhost:3001`, Web `http://localhost:3000`.

## 1. Overview

This guide covers end-to-end testing of Duplicate Detection and Merge for the CRM. The system must detect fuzzy duplicates across Contacts (primary), Accounts, and Leads, classify candidates as `exact` / `high` / `medium` confidence, surface them in a Dedup Queue page, support on-create inline warnings plus a nightly batch job, provide a per-field winner Merge Picker Modal, preserve history (activities, notes, deals, timelines), write audit log entries, and guard destructive actions such as deleting a contact with an open deal.

Scope:

- Duplicate detection rules: email exact, phone normalized, name fuzzy (trigram / Levenshtein / soundex), account + domain matching.
- Confidence tiers: `exact` (same normalized email or phone + name), `high` (>=0.85 score), `medium` (0.65–0.84).
- Triggers: on-create / on-update real-time check + nightly job (`dedup:nightly` cron at 02:00 UTC) + manual “Find duplicates” button.
- Merge UI: `merge-picker-modal` with per-field radio winner selection, master record selection, preview, confirm.
- Post-merge: loser soft-deleted / merged status, winner retains merged history, loser ID redirect (301/alias), audit log `contact.merge`.
- Dedup Queue page: `/contacts/duplicates` list, filters by confidence/object type/status, bulk dismiss, assign reviewer.
- Guards: delete-contact-with-open-deal warning modal blocking hard delete; merge blocked if loser has open deal without explicit acknowledgment.

Out of scope: cross-org dedup (org isolation enforced), external enrichment dedup.

Key user stories:

1. As a Sales Rep, I am warned on contact create if a duplicate likely exists so I don’t create a dup.
2. As a Data Steward, I can review the dedup queue, compare side-by-side, pick per-field winners, and merge.
3. As an Admin, I can configure matching thresholds and see audit history of merges.

## 2. Prerequisites & Test Data Setup

### 2.1 Environment prerequisites

- API running on `http://localhost:3001` (`npm run dev:api` or `docker compose up api`).
- Web running on `http://localhost:3000`.
- Postgres seeded; Redis / BullMQ for nightly job queue if async.
- Test org: `test-dedup-org` with 2 users: `admin@test.com / Admin123!` (Admin) and `steward@test.com / Steward123!` (Data Steward role with `contacts:merge`, `contacts:delete`).
- Feature flags: `dedup_enabled=true`, `fuzzy_match_enabled=true`.
- Audit log viewer accessible at `/settings/audit-log`.

### 2.2 Seed data script (API)

Create baseline contacts that will generate exact/high/medium candidates:

```bash
# login
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@test.com","password":"Admin123!"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
echo $TOKEN

# Master contact
curl -s -X POST http://localhost:3001/api/contacts \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"firstName":"Jonathan","lastName":"Smith","email":"jon.smith@acme.com","phone":"+1-415-555-0132","accountName":"Acme Inc","title":"VP Sales","ownerId":"admin"}'

# Exact duplicate (same email different case + phone formatting)
# Expected: exact candidate
# Contact B

# High duplicate (typo + same phone normalized)
# Contact C: Jonathon Smyth, jon.smith@acme.com typo? Or same phone

# Medium duplicate (same name, different domain, similar phone)
```

### 2.3 Manual test data set (create via UI at http://localhost:3000/contacts/new)

| ID           | Name           | Email                    | Phone             | Account  | Expected Match vs Master                      |
| ------------ | -------------- | ------------------------ | ----------------- | -------- | --------------------------------------------- |
| C-001 Master | Jonathan Smith | jon.smith@acme.com       | +1 (415) 555-0132 | Acme Inc | —                                             |
| C-002        | JONATHAN SMITH | JON.SMITH@ACME.COM       | 4155550132        | Acme Inc | exact                                         |
| C-003        | Jonathon Smyth | jon.smith@acme.com       | +14155550132      | Acme     | high (name distance 2 + email exact)          |
| C-004        | Jon Smith      | j.smith@acme.com         | +1-415-555-0132   | Acme Inc | high (phone exact + name fuzzy)               |
| C-005        | Jonathan Smith | jonathan.smith@gmail.com | +1-415-555-0199   | —        | medium (name exact only)                      |
| C-006        | Jane Doe       | jane.doe@other.com       | +1-212-555-0100   | Other Co | no match (control)                            |
| A-001        | Acme Inc       | info@acme.com            | —                 | —        | account exact candidate for A-002 `Acme Inc.` |

### 2.4 Deals / history for preservation tests

- Create open deal `D-OPEN-1` on C-003 (loser): amount $25k, stage `Negotiation`, owner steward.
- Create closed-won deal `D-WON-1` on C-001 (master).
- Add 3 notes + 2 tasks + 1 email activity to C-003; 1 note to C-001 with conflicting `title` and `phone` values to test conflicting-values picker.
- Conflicting-values pair: Master `title=VP Sales, phone=+1-415-555-0132` vs Loser `title=Head of Sales, phone=+1-415-555-0140`.

### 2.5 Nightly job trigger

- Ensure cron disabled in test or set to manual: `DEDUP_CRON_ENABLED=false` then trigger manually via API `POST /api/jobs/dedup/run`.
- Have at least 50 contacts to verify batch performance (<60s for 1k).

## 3. Test Environment Matrix

| Dimension        | Variants to Cover                                                               |
| ---------------- | ------------------------------------------------------------------------------- |
| Browser          | Chrome 126, Firefox 128, Safari 17, Edge 126                                    |
| Viewport         | 1440p desktop, 768p tablet, 375px mobile (queue table -> cards)                 |
| Role             | Admin, Data Steward (merge allowed), Sales Rep (view only, no merge), Read-only |
| Org isolation    | Same org sees duplicates; second org `other-org` must see zero candidates       |
| Data volume      | 5 contacts, 1k contacts, 10k contacts (nightly timing)                          |
| API vs UI        | All merges via UI + via API `POST /api/contacts/merge`                          |
| Feature flag off | `dedup_enabled=false` → no warnings, queue empty state                          |
| Timezone         | UTC, America/Los_Angeles (nightly 02:00 UTC correctness)                        |
| Network          | Normal, throttled 3G (merge modal still usable), offline retry                  |

Performance SLOs: on-create check p95 <800ms; dedup queue page load p95 <2s for 500 candidates; merge transaction <3s; nightly 10k contacts <5 min.

## 4. Detailed Step-by-Step Test Cases (at least 20 numbered TC cases)

### TC-01: On-create exact duplicate warning (inline)

Steps:

1. Login as Sales Rep, go to `http://localhost:3000/contacts/new`.
2. Enter First=Jonathan, Last=Smith, Email=`JON.SMITH@ACME.COM`, Phone=`4155550132`.
3. Tab out of Email field, wait 1s.
4. Observe inline banner: “Possible duplicate: Jonathan Smith (Exact – same email) – View / Dismiss”.
   Expected: Banner appears within 2s, shows confidence badge `Exact`, link opens C-001 in side peek, creation not blocked but “Create anyway” requires checkbox acknowledge.

### TC-02: On-create high-confidence fuzzy warning

Steps:

1. New contact: `Jonathon Smyth`, email `jon.smith@acme.com`, phone `+14155550132`.
2. Verify warning shows `High` with score e.g., 0.91 and reason “Name similar (0.88) + Email exact + Phone exact”.
3. Click “Compare” → side-by-side diff modal.
   Expected: Score breakdown visible; Compare modal highlights differing chars.

### TC-03: On-create medium candidate does NOT block, only suggests

Steps:

1. New contact: `Jonathan Smith`, email `jonathan.smith@gmail.com`.
2. Verify subtle suggestion (grey) “1 medium match”, no checkbox required.
   Expected: User can save without acknowledge; candidate appears in queue later.

### TC-04: No false positive – control contact

Steps:

1. Create `Jane Doe / jane.doe@other.com`.
2. Verify no warning.
   Expected: No banner; no candidate row created for Jane after nightly run.

### TC-05: Dedup queue page lists candidates grouped

Steps:

1. As Steward go to `http://localhost:3000/contacts/duplicates`.
2. Verify tabs: All / Exact / High / Medium / Dismissed / Merged; filters: Object=Contact, Status, Owner, Date.
3. Verify C-002/C-001 pair shows `Exact`, C-003/C-001 `High`, C-005/C-001 `Medium`.
   Expected: Sorted Exact→High→Medium; each row shows both names, match reasons, score, age, actions View/Merge/Dismiss.

### TC-06: Nightly job creates missing candidates

Steps:

1. Via API directly insert two dup contacts bypassing on-create check (flag `skipDedup:true` as admin).
2. Run `POST http://localhost:3001/api/jobs/dedup/run`.
3. Poll `GET /api/duplicates?status=pending` until count +1.
4. Re-check queue UI.
   Expected: New candidate appears with `source=nightly`, `createdAt` ≈ job run time; job log shows `scanned=X, pairs=Y, duration<60s`.

### TC-07: Per-field winner merge UI – conflicting-values test (CRITICAL)

Steps:

1. In queue, select pair Master C-001 vs Loser C-003, click Merge.
2. Verify `merge-picker-modal` opens: header shows Master selector (radio C-001 default), field rows: FirstName, LastName, Email, Phone, Title, Account, Owner, Custom fields.
3. Each row shows both values side-by-side with radio to pick winner. Conflicting rows highlighted yellow: Title (`VP Sales` vs `Head of Sales`), Phone (`...0132` vs `...0140`), Email same → auto-selected + locked with “Identical” tag.
4. Pick Title winner = Loser (`Head of Sales`), Phone winner = Master, Email = Master.
5. Preview pane shows resulting merged contact.
6. Check “I understand this cannot be undone” + click Confirm Merge.
   Expected: API `POST /api/contacts/merge` with `fieldWinners:{title:loser, phone:master,...}`; resulting contact has Title=`Head of Sales`, Phone=`...0132`; UI toast “Merged successfully – View merged contact”; modal closes; queue row moves to Merged.

### TC-08: History preservation after merge

Steps:

1. After TC-07, open merged master C-001 timeline.
2. Verify: 3 notes + 2 tasks + 1 email from loser now attached to master, with `mergedFrom:C-003` tag; open deal D-OPEN-1 reassigned to master; closed deals intact; activity timestamps preserved.
3. Visit old URL `/contacts/C-003` → redirects to `/contacts/C-001?mergedFrom=C-003` with banner.
   Expected: No orphaned notes/tasks; deal count on master = 2; timeline chronological.

### TC-09: Audit log entry for merge

Steps:

1. Go to `/settings/audit-log?entity=contact&entityId=C-001`.
2. Verify entry `contact.merge` with actor=steward, timestamp, `metadata:{winnerId, loserId, fieldWinners, confidence}`.
3. Verify loser has `contact.merged_into` entry.
   Expected: Both entries present, immutable (no delete button), exportable.

### TC-10: Dismiss candidate with reason

Steps:

1. Select medium pair C-005/C-001, click Dismiss, choose reason `Not duplicates` + note.
2. Verify row moves to Dismissed tab, `dismissedBy`/`dismissedAt` recorded.
3. Re-run nightly job → dismissed pair must NOT reappear (suppression list).
   Expected: Suppression holds; audit `duplicate.dismissed`.

### TC-11: Undo dismiss / reopen

Steps:

1. In Dismissed tab, click Reopen on TC-10 pair.
2. Verify back to pending.
   Expected: Status change logged.

### TC-12: Delete-contact-with-open-deal warning (CRITICAL)

Steps:

1. Create fresh loser C-007 with open deal D-OPEN-2.
2. Try Delete (UI trash icon) on C-007.
3. Verify blocking warning modal: “This contact has 1 open deal ($X). Deleting will … Reassign or close deal first. [Reassign deal] [Cancel] [Delete anyway – requires typing DELETE]”.
4. Type DELETE and confirm → verify soft delete + deal reassigned to org unassigned or blocked per setting.
5. Repeat merge where loser has open deal: merge modal must show amber warning “Loser has 1 open deal – will be moved to master” + require checkbox.
   Expected: No silent data loss; hard delete without typing blocked; merge without ack checkbox disabled.

### TC-13: Merge validation – same record / cross-org blocked

Steps:

1. API: attempt merge winner==loser → expect 400 `cannot_merge_same`.
2. Attempt merge C-001 (org A) with contact from other-org → expect 403.
3. Attempt merge already-merged loser C-003 again → expect 410 `already_merged`.
   Expected: Proper error codes + messages; UI shows toast errors.

### TC-14: Bulk dismiss in queue

Steps:

1. Select 5 medium candidates via checkboxes, Bulk Dismiss.
2. Verify all move to dismissed, toast count.
   Expected: Single API batch call, <2s.

### TC-15: Permissions – Sales Rep cannot merge

Steps:

1. Login as Sales Rep, open dedup queue.
2. Verify Merge button disabled with tooltip “Requires Data Steward”, Dismiss hidden.
3. Direct API `POST /api/contacts/merge` as Rep → 403.
   Expected: UI + API enforcement.

### TC-16: Account deduplication (exact)

Steps:

1. Create `Acme Inc.` vs `Acme Inc` (trailing period) with same domain `acme.com`.
2. Verify exact candidate in Accounts dedup tab.
3. Merge accounts → verify contacts under loser account re-parented to winner, deals moved.
   Expected: Cascade re-parent, no orphan contacts.

### TC-17: Phone normalization edge cases

Steps:

1. Create contacts with `+1 (415) 555-0132`, `14155550132`, `415-555-0132 ext 0`.
2. Verify all three pairwise score phone-exact.
3. Create with `+44 20 7946 0018` (different country) → no phone match.
   Expected: Normalization via E.164; UI shows normalized form in tooltip.

### TC-18: Threshold configuration

Steps:

1. As Admin go to `/settings/dedup` – set High threshold 0.85→0.95.
2. Re-run detection on C-004 (score 0.88) → should downgrade High→Medium.
3. Revert to 0.85.
   Expected: Config persists, queue re-scores without duplicate rows (update score in place).

### TC-19: Large-volume nightly performance smoke

Steps:

1. Seed 1000 generated contacts (script) with 5% intentional dups.
2. Run nightly job, measure duration, check queue pagination (50/page) works, search filters still fast.
   Expected: Job <60s, UI paginated, no timeout.

### TC-20: Merge with custom fields + attachments

Steps:

1. Add custom field `VIP=true` on loser, `VIP=false` on master; attach file to loser.
2. Merge picking VIP=winner loser, verify custom field + attachment moved.
   Expected: Attachments re-linked, custom values per picker.

### TC-21: Concurrent merge race (optimistic locking)

Steps:

1. Open same pair in two browsers (Steward + Admin), both click Confirm simultaneously.
2. Verify one succeeds, second gets 409 `duplicate_already_merged` with friendly message + refresh.
   Expected: No double-merge corruption.

### TC-22: Accessibility & responsive of merge modal

Steps:

1. Keyboard-only: Tab through radios, Space select, Enter confirm.
2. Zoom 200%, 375px width: modal scrolls, sticky footer Confirm visible.
   Expected: Focus trap, aria-labels, no clipped buttons.

## 5. API Testing Section

| Method & Endpoint                                                                        | Purpose                          | Auth              | Expected                                                      |
| ---------------------------------------------------------------------------------------- | -------------------------------- | ----------------- | ------------------------------------------------------------- |
| `GET /api/duplicates?status=pending&confidence=exact&objectType=contact&page=1&limit=20` | List queue                       | Bearer            | 200 `{data:[{id,pairIds,score,confidence,reasons}], total}`   |
| `GET /api/duplicates/:id`                                                                | Candidate detail with field diff | Bearer            | 200 with `fieldDiffs[]`                                       |
| `POST /api/contacts/check-duplicates`                                                    | On-create live check             | Bearer            | 200 `{matches:[{contactId,score,confidence}]}` p95<800ms      |
| `POST /api/contacts/merge`                                                               | Execute merge                    | Bearer (steward+) | 200 `{winner, loserId, mergedFields}` or 4xx                  |
| `POST /api/duplicates/:id/dismiss`                                                       | Dismiss with reason              | Bearer            | 200 `{status:dismissed}`                                      |
| `POST /api/duplicates/:id/reopen`                                                        | Reopen                           | Bearer            | 200                                                           |
| `POST /api/jobs/dedup/run`                                                               | Trigger nightly manually         | Admin             | 202 `{jobId}` + poll `/api/jobs/:jobId`                       |
| `GET /api/audit-log?entity=contact&entityId=:id`                                         | Verify merge audit               | Admin/Steward     | 200 includes `contact.merge`                                  |
| `DELETE /api/contacts/:id`                                                               | Delete with guard                | Bearer            | 409 if open deals without `force:true` + `confirmText:DELETE` |

### curl examples (API http://localhost:3001)

```bash
# 0) Login and set token
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"steward@test.com","password":"Steward123!"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

# 1) Live on-create check (fuzzy)
curl -s -X POST http://localhost:3001/api/contacts/check-duplicates \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"firstName":"Jonathon","lastName":"Smyth","email":"jon.smith@acme.com","phone":"+14155550132"}' | python3 -m json.tool

# 2) List high+exact queue
curl -s "http://localhost:3001/api/duplicates?status=pending&objectType=contact&limit=20" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# 3) Get candidate detail with field diffs
CAND_ID="dup_abc123"
curl -s http://localhost:3001/api/duplicates/$CAND_ID \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# 4) Execute per-field winner merge (conflicting-values test)
curl -s -X POST http://localhost:3001/api/contacts/merge \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "winnerId":"c_master_001",
    "loserId":"c_loser_003",
    "fieldWinners":{"firstName":"winner","lastName":"winner","email":"winner","phone":"winner","title":"loser","accountId":"winner"},
    "acknowledgeOpenDeals": true,
    "confirmText":"MERGE"
  }' | python3 -m json.tool

# 5) Dismiss medium candidate
curl -s -X POST http://localhost:3001/api/duplicates/$CAND_ID/dismiss \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"not_duplicates","note":"Different person, same name"}' | python3 -m json.tool

# 6) Trigger nightly job + poll
JOB=$(curl -s -X POST http://localhost:3001/api/jobs/dedup/run \
  -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json;print(json.load(sys.stdin)['jobId'])")
curl -s http://localhost:3001/api/jobs/$JOB -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# 7) Delete guard – expect 409 without force
curl -s -X DELETE http://localhost:3001/api/contacts/c_007 \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
# then forced with typed confirmation:
curl -s -X DELETE "http://localhost:3001/api/contacts/c_007?force=true" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"confirmText":"DELETE","reassignDealsTo":"c_master_001"}' | python3 -m json.tool

# 8) Verify audit log
curl -s "http://localhost:3001/api/audit-log?entity=contact&entityId=c_master_001&action=contact.merge" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

Negative API tests: winner==loser → 400; cross-org → 403; already merged → 410; missing `acknowledgeOpenDeals` when loser has open deal → 422; invalid confidence filter → 400.

## 6. UI Testing Section

Routes: `/contacts/duplicates` (Dedup Queue), `/contacts/new` (inline warning), `/contacts/:id` (merge history banner), modal `merge-picker-modal`.

Checklist:

- Queue table columns: Checkbox, Pair (avatars + names), Confidence badge (Exact=red, High=orange, Medium=grey), Score bar, Reasons chips (`email_exact`, `phone_exact`, `name_fuzzy:0.88`), Age, Owner, Actions. Sort by confidence/score.
- Filters persist in URL query (`?confidence=high&status=pending`); refresh retains; shareable link.
- Merge modal: master selector at top (two cards with radio), field rows with radio per side, identical rows collapsed with check, conflicting highlighted, preview panel live-updates, Confirm disabled until ack checkbox + required fields picked.
- Inline create warning: Exact=red banner blocking-ish, High=orange, Medium=grey subtle; “Compare” opens diff; “Dismiss for this form” snoozes.
- Delete warning modal: shows open deal list with amounts/stages, Reassign dropdown, typed DELETE input, destructive button disabled until valid.
- Toasts: success `Merged C-003 → C-001`, error with requestId.
- Empty states: “No duplicates – you’re clean!” with illustration + Run detection button.
- Loading skeletons, pagination, bulk bar (`3 selected – Merge?/Dismiss`), responsive cards on mobile.
- Visual: confidence badge colors, score bar animation, focus trap in modal, ESC closes (with dirty confirm if selections made).

Cross-browser: verify modal scroll + sticky footer on Safari; table horizontal scroll on 375px.

## 7. Regression & Cross-Feature Impact

| Area                   | Impact                                                              | What to Retest                                                                    |
| ---------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Contacts CRUD          | Merge changes winner fields; loser redirect                         | Edit winner after merge, search finds winner by loser old email alias             |
| Deals Pipeline         | Deals reassigned                                                    | Pipeline totals unchanged, deal detail shows new contact link, no duplicate deals |
| Activities/Tasks/Notes | Re-parented                                                         | Task assignees unchanged, calendar still shows tasks, activity filters            |
| Search                 | Loser email should still resolve to winner (alias)                  | Global search `jon.smith@acme.com` returns winner                                 |
| Imports                | Import may create dups → queue spike                                | Import 500 rows with dups, verify queue + on-create checks don’t block import job |
| Workflows/Automation   | Merge triggers `contact.merged` webhook, not `contact.created`      | Check Zapier/webhook logs, no duplicate workflow runs                             |
| Audit Logs             | Merge/dismiss entries                                               | Retention, export CSV includes merge                                              |
| Permissions            | Steward-only merge                                                  | Rep regression: create/edit still works, merge hidden                             |
| Reports                | Contact counts should decrement by 1 per merge (loser soft-deleted) | Dashboard counts, dedup KPI report                                                |
| Email sync             | Loser email thread moved                                            | Email timeline on winner shows thread                                             |
| Notifications          | Reviewer assigned gets notified                                     | Bell + email notify on queue assignment                                           |

Full regression pack: run `contacts`, `deals-pipeline`, `audit-logs`, `imports-exports` smoke after dedup changes.

## 8. Expected Results Summary Table

| TC    | Feature          | Input                        | Expected Result                 | Pass Criteria                   |
| ----- | ---------------- | ---------------------------- | ------------------------------- | ------------------------------- |
| TC-01 | On-create exact  | Same email diff case         | Red Exact banner + ack required | Banner <2s, link works          |
| TC-02 | High fuzzy       | Typo name + same email/phone | Orange High + score breakdown   | Score ≥0.85, Compare works      |
| TC-03 | Medium           | Same name only               | Grey suggestion, no block       | Save succeeds                   |
| TC-04 | Control          | Unique Jane                  | No warning                      | Zero candidates                 |
| TC-05 | Queue list       | 3 pairs                      | Exact/High/Medium sorted        | Filters work                    |
| TC-06 | Nightly          | Bypassed inserts             | New `nightly` candidate         | Job log correct                 |
| TC-07 | Merge picker     | Conflicting title/phone      | Per-field winners applied       | Result Title=Head, Phone=master |
| TC-08 | History          | Loser with notes/deal        | All moved, redirect             | No orphans, redirect banner     |
| TC-09 | Audit            | After merge                  | `contact.merge` entry           | Immutable, exportable           |
| TC-10 | Dismiss          | Medium + reason              | Moves to Dismissed, suppressed  | No reappear                     |
| TC-11 | Reopen           | Dismissed                    | Back to pending                 | Logged                          |
| TC-12 | Delete guard     | Contact + open deal          | Blocking modal + typed DELETE   | No silent loss                  |
| TC-13 | Merge validation | Same/cross-org/re-merge      | 400/403/410                     | Toast errors                    |
| TC-14 | Bulk dismiss     | 5 select                     | All dismissed                   | Batch <2s                       |
| TC-15 | Perms            | Rep merge                    | Disabled + 403                  | Enforced                        |
| TC-16 | Account merge    | Acme Inc.                    | Re-parent contacts              | No orphans                      |
| TC-17 | Phone norm       | Formats                      | E.164 match                     | Tooltip                         |
| TC-18 | Threshold        | 0.95                         | Downgrade to Medium             | Persist                         |
| TC-19 | Perf 1k          | Seed                         | <60s, paginated                 | No timeout                      |
| TC-20 | Custom+file      | VIP + attach                 | Moved per picker                | Linked                          |
| TC-21 | Race             | Double confirm               | One 200 one 409                 | No corruption                   |
| TC-22 | A11y             | Keyboard/mobile              | Trap + scroll                   | No clip                         |

## 9. Troubleshooting & Common Failures

| Symptom                             | Likely Cause                                                                    | Fix / Check                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| No inline warning appears           | `dedup_enabled=false`, or token lacking `contacts:read`, or debounce not waited | Check `/settings/dedup` flag, Network tab `check-duplicates` 200?, wait 1.5s after blur    |
| Queue empty after seed              | Nightly not run, org mismatch, status filter `pending` vs `all`                 | Run `POST /jobs/dedup/run`, check `orgId`, clear filters                                   |
| Merge 422 `open_deals_ack_required` | Loser has open deal, checkbox missed                                            | Tick “Move open deals” ack in modal / send `acknowledgeOpenDeals:true`                     |
| Merge 409 already_merged            | Double-click / race / already merged                                            | Refresh queue, verify winner timeline, check audit                                         |
| Merge modal Confirm disabled        | Required fieldWinners missing or ack unchecked                                  | Select all conflicting radios, tick confirm checkbox, enter MERGE if required              |
| Score seems wrong (High vs Medium)  | Threshold changed or phone not normalized (ext)                                 | Check Admin thresholds, inspect `reasons` breakdown, test normalization endpoint           |
| Deleted contact still in search     | Soft-delete index lag / alias retained intentionally                            | Wait 30s / reindex; alias is expected – click should redirect                              |
| Nightly job stuck `running`         | Redis down / job crash                                                          | Check `docker compose ps redis`, `GET /api/jobs/:id/logs`, retry                           |
| 403 on merge as Steward             | Role missing `contacts:merge` scope                                             | Admin → Roles → add scope, re-login for new JWT                                            |
| Redirect loop `/contacts/C-003`     | Loser `mergedIntoId` null or winner also merged (chain)                         | Follow chain: C-003→C-001→C-010 (chained merges resolve to ultimate winner); DB check      |
| Performance: check-duplicates >2s   | Missing trigram index `pg_trgm` or 10k scan without limit                       | `CREATE EXTENSION pg_trgm`, check `EXPLAIN`, ensure blocking keys (email/phone) pre-filter |

Logs: API `logs/dedup.log`, job worker stdout, browser console for `merge-picker-modal` state. Include `requestId` from toast when filing bug.

## 10. Pass/Fail Checklist

- [ ] TC-01 Exact inline warning shows <2s with ack checkbox
- [ ] TC-02 High fuzzy shows score + reasons + Compare modal
- [ ] TC-03 Medium is non-blocking suggestion
- [ ] TC-04 Control creates zero candidates
- [ ] TC-05 Queue lists Exact/High/Medium sorted with filters
- [ ] TC-06 Nightly `nightly` source candidate created + job log sane
- [ ] TC-07 Conflicting-values per-field merge applies Title=loser/Phone=master + preview correct
- [ ] TC-08 History (notes/tasks/deals/attachments) preserved + old URL redirects
- [ ] TC-09 Audit `contact.merge` + `merged_into` immutable entries
- [ ] TC-10 Dismiss with reason suppresses re-creation on next nightly
- [ ] TC-11 Reopen works
- [ ] TC-12 Delete-contact-with-open-deal blocking modal + typed DELETE + merge ack required
- [ ] TC-13 Same/cross-org/re-merge → 400/403/410
- [ ] TC-14 Bulk dismiss works
- [ ] TC-15 Rep cannot merge (UI disabled + API 403)
- [ ] TC-16 Account merge re-parents contacts/deals
- [ ] TC-17 Phone E.164 normalization correct
- [ ] TC-18 Threshold change re-scores
- [ ] TC-19 1k nightly <60s + pagination
- [ ] TC-20 Custom fields + attachments moved
- [ ] TC-21 Concurrent merge → 200 + 409, no corruption
- [ ] TC-22 Keyboard + mobile modal usable
- [ ] API curl 1–8 all return expected codes
- [ ] Regression: deals totals, search alias, workflows webhook, reports counts intact
- [ ] No console errors, no orphaned records in DB (`SELECT * FROM notes WHERE contact_id NOT IN (...)` empty)

Sign-off: Tester __________ Date __________ Env (staging/prod) __________ Build hash __________
