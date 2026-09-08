# Inline Editing – Comprehensive Testing Guide

Base URLs: API `http://localhost:3001`, Web `http://localhost:3000` (pure frontend optimistic UI + rollback toast – no curl; use UI steps + localStorage/network checks instead).

## 1. Overview

This guide covers Click-to-Edit Optimistic UI with Rollback Toast: editing cell/field values inline in lists and detail headers without a full form.
Scope includes deal/contact/task inline fields (name, amount, stage dropdown, dates, owner assign, tags), enter-to-save / esc-to-cancel / blur-to-save semantics, optimistic update with pending shimmer, success toast with Undo, failure rollback with retry, validation inline, concurrency (two editors), and audit/timeline reflection.
Out of scope is bulk edit (unless inline multi-select) and full-form edit – but parity of validation rules is checked.
Key roles: users with record edit permission see affordances; viewers see plain text (no affordance, no API write).
Critical rules: UI updates instantly (<50ms perceived) before server ACK; on 4xx/5xx or offline, value rolls back + toast `Couldn't save – Retry`; `Esc` cancels pre-save; concurrent newer wins or conflict prompt per spec (document).
Success criteria: happy-path saves persist, failures roll back visibly, validation blocks bad input both layers, and viewers cannot trigger writes.

## 2. Prerequisites & Test Data Setup

- App Web `http://localhost:3000` + API `:3001` running; network throttling + offline toggle available.
- Records: `DEAL-INLINE` ($8000, Qualification, owner rep1), `CONTACT-INLINE`, `TASK-INLINE` (title + due date); note IDs + baseline `updatedAt`.
- Users: rep1 (owner/editor), rep2 (editor with access), viewer (read-only); login each in separate profile/tab for concurrency.
- Browser: Chrome + Firefox; DevTools Network (preserve log) to observe `PATCH` timing vs paint; console for errors.
- localStorage: optimistic queue key if any (e.g., `crm.pendingEdits` – document actual; may be in-memory only – note).
- Cleanup: revert QA edits to baseline after run; screenshot pending/rollback states.

## 3. Test Environment Matrix

| Dimension  | Variants                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------ |
| Field type | Text (name), Number/currency (amount), Select (stage/status), Date (close/due), Assignee (user picker), Tags/multi |
| Surface    | Deals table cell, Deal detail header, Contact list, Task board/focus, Home rows (if inline)                        |
| Browser    | Chrome, Firefox, Edge                                                                                              |
| Viewport   | 1440px, 768px (popover fits)                                                                                       |
| Role       | Owner, Shared editor, Viewer (no affordance)                                                                       |
| Network    | Online fast, Slow 3G (pending visible), Offline (rollback), 500 forced                                             |
| Input      | Keyboard-only, Mouse-only                                                                                          |
| Theme      | Light/Dark (pending/error colors)                                                                                  |

- Record: field, old→new values, paint ms vs PATCH ms, toast text, `updatedAt` before/after.
- Verify validation parity with full-form (same min/max/required).

## 4. Detailed Step-by-Step Test Cases (at least 18 numbered TC cases)

### TC-01 – Text Inline Edit Happy Path (Deal Name)

- **Objective:** Verify click → type → Enter saves + persists.
- **Preconditions:** `DEAL-INLINE` open in table; baseline name recorded.
- **Steps:**
  1. Hover name cell; verify pencil/underline affordance.
  2. Click; verify input focused with current value selected.
  3. Type `Acme Renamed [QA]`; press `Enter`.
  4. Verify cell shows new value instantly (<50ms) with subtle pending dot/shimmer.
  5. Verify success (pending clears, toast `Saved` + Undo 5s).
  6. Reload; verify persists.
- **Expected:** Instant paint; persists; Undo available.

### TC-02 – Number/Currency Edit (Amount) + Formatting

- **Objective:** Verify amount editing with formatting + validation.
- **Preconditions:** Amount 8000.
- **Steps:**
  1. Click amount → type `12500.50` → Enter.
  2. Verify instant `$12,500.50` formatting.
  3. Reload; verify `12500.5` stored (check detail + reports total delta).
  4. Try `abc` → blocked inline `Enter a number`.
- **Expected:** Formatted; stored numeric; invalid blocked.

### TC-03 – Select Edit (Stage Dropdown)

- **Objective:** Verify stage change inline with pipeline guardrails.
- **Preconditions:** Stage Qualification.
- **Steps:**
  1. Click stage pill → dropdown with all pipeline stages.
  2. Select Negotiation via mouse; verify instant pill change + timeline entry `Stage changed`.
  3. Keyboard: reopen, ArrowDown + Enter selects.
  4. Reload; verify persists + Reports reflect.
- **Expected:** Both mouse + keyboard; timeline logged.

### TC-04 – Date Edit (Close/Due Picker)

- **Objective:** Verify date inline with calendar + manual input.
- **Preconditions:** Close date set.
- **Steps:**
  1. Click date → calendar opens.
  2. Pick tomorrow via click; verify instant `Sep 9` + PATCH.
  3. Type `2026-13-40` → inline `Invalid date` blocked.
  4. `Esc` mid-picker → no change.
- **Expected:** Picker + typing; invalid blocked; Esc safe.

### TC-05 – Assignee Picker Inline

- **Objective:** Verify owner reassignment inline notifies.
- **Preconditions:** Owner rep1.
- **Steps:**
  1. Click owner avatar → user list (search `rep2`).
  2. Select rep2; verify instant avatar swap + toast.
  3. As rep2 verify bell `Assigned` (per notif prefs).
  4. Revert to rep1.
- **Expected:** Swap + notify; search filters.

### TC-06 – Blur-to-Save vs Esc-to-Cancel Semantics

- **Objective:** Pin save/cancel contract.
- **Preconditions:** Name cell editing.
- **Steps:**
  1. Edit + click outside (blur) → verify saves (or cancels per spec – document actual).
  2. Edit + `Esc` → verify cancels, old value restored, no PATCH sent (check Network).
  3. Edit + `Enter` → saves.
- **Expected:** Documented trio; Network proves Esc sends nothing.

### TC-07 – Optimistic Paint Before PATCH ACK (Slow 3G Proof)

- **Objective:** Prove optimism (<50ms paint, PATCH later).
- **Preconditions:** Throttle Slow 3G; Network tab open.
- **Steps:**
  1. Start Performance mark; edit name + Enter.
  2. Verify paint immediate while PATCH `Pending` in Network.
  3. Note paint ms vs response ms (e.g., paint 30ms, ACK 1200ms).
  4. On ACK verify pending clears, no flicker.
- **Expected:** Paint ≪ ACK; no revert on success.

### TC-08 – Failure Rollback + Retry Toast (Forced 500/Offline)

- **Objective:** Verify rollback visible + retry works.
- **Preconditions:** Ability to force fail (offline toggle or proxy 500 for `PATCH /api/deals/:id`).
- **Steps:**
  1. Go offline; edit amount 8000→9999 + Enter.
  2. Verify optimistic 9999 briefly, then rollback to 8000 + toast `Couldn't save – Retry` with Retry button.
  3. Go online; click Retry; verify 9999 applies + persists.
  4. Verify `updatedAt` unchanged by failed attempt.
- **Expected:** Rollback + retry; no stuck 9999 on failure.

### TC-09 – Validation Inline (Required/Min/Max/Length)

- **Objective:** Verify client + server agreement.
- **Preconditions:** Name required, amount ≥0, notes ≤2000 chars (confirm limits).
- **Steps:**
  1. Clear name → Enter → `Name required`, no PATCH.
  2. Amount `-5` → `Must be ≥ 0`.
  3. Paste 5000 chars into notes → counter + block at limit.
  4. Bypass client (tamper via console `fetch PATCH`) with bad value → server 400 (prove via Network – still allowed to note, even though guide is UI-first).
- **Expected:** Inline blocks; server also 400 (no corrupt write).

### TC-10 – Undo Within Toast Window

- **Objective:** Verify Undo reverts + persists.
- **Preconditions:** Successful edit with Undo toast visible.
- **Steps:**
  1. Edit name A→B; click Undo within 5s.
  2. Verify cell flips B→A instantly + PATCH revert sent.
  3. Reload; verify A persists.
  4. Edit again; let toast expire; verify Undo gone (no late undo).
- **Expected:** Timed undo; revert persists.

### TC-11 – Concurrent Edits (Two Tabs, Last-Write/Conflict)

- **Objective:** Verify conflict handling.
- **Preconditions:** Same deal in Tab A (rep1) + Tab B (rep2).
- **Steps:**
  1. A edits name → `Alpha`; B edits same field → `Beta` seconds later.
  2. Verify winner per spec: last-write-wins (`Beta`) OR conflict banner `rep1 changed this – Reload/Keep mine` – document.
  3. Verify timeline shows both attempts (or winner + conflict note).
  4. Reload both; verify single truth.
- **Expected:** No silent merge corruption; deterministic.

### TC-12 – Viewer Sees No Affordance + Write Blocked

- **Objective:** Verify read-only has no edit path.
- **Preconditions:** Viewer login.
- **Steps:**
  1. Hover cells; verify no pencil/underline, click does nothing (or tooltip `Read-only`).
  2. Keyboard: Tab reaches cell as text, Enter does not open editor.
  3. Attempt direct `PATCH` via console with viewer token → 403 (Network proof).
- **Expected:** No affordance + API 403.

### TC-13 – Rapid Double-Edit (Debounce/Queue)

- **Objective:** Verify quick successive saves queue correctly.
- **Preconditions:** Amount cell.
- **Steps:**
  1. Edit 8000→8100 Enter, immediately 8100→8200 Enter.
  2. Verify final 8200, Network shows 2 PATCHes serialized (or 1 coalesced with latest – document).
  3. Reload; verify 8200.
- **Expected:** No lost update; order preserved.

### TC-14 – Special Content (Emoji/Unicode/Quotes/Commas)

- **Objective:** Verify encoding round-trips.
- **Preconditions:** Name cell.
- **Steps:**
  1. Set `Zoë "Big", 😀 Co`.
  2. Verify renders + persists + CSV export preserves (spot-check `reports.md`).
  3. Verify search finds it (palette/list).
- **Expected:** No mojibake/truncation.

### TC-15 – XSS Payload Escaped

- **Objective:** Verify `<script>` inert.
- **Preconditions:** Notes/name inline.
- **Steps:**
  1. Set `<img src=x onerror=alert(1)> [QA xss]`.
  2. Verify rendered as text, no alert; DOM shows escaped.
  3. Reload; still inert.
- **Expected:** Escaped; no execution.

### TC-16 – Tab Navigation Across Cells (Spreadsheet Feel)

- **Objective:** Verify `Tab` commits + moves next.
- **Preconditions:** Table with editable Name + Amount adjacent.
- **Steps:**
  1. Edit Name + `Tab`; verify Name saves + Amount editor opens focused.
  2. `Shift+Tab` returns.
  3. `Esc` mid-chain cancels current only.
- **Expected:** Excel-like flow (or documented alternative).

### TC-17 – Pending/Disabled States Prevent Double-Submit

- **Objective:** Verify no duplicate PATCH on double-Enter.
- **Preconditions:** Slow 3G.
- **Steps:**
  1. Edit + press Enter twice rapidly.
  2. Verify single PATCH in Network (button/input disabled pending).
  3. Verify single timeline entry.
- **Expected:** Idempotent; no dupes.

### TC-18 – Audit/Timeline Reflects Inline Writes

- **Objective:** Verify attribution.
- **Preconditions:** Fresh edit.
- **Steps:**
  1. Edit stage via inline; open record Timeline/Activity.
  2. Verify entry `rep1 changed Stage Qualification → Negotiation via inline` with timestamp.
  3. Verify actor correct (not `system` unless workflow).
- **Expected:** Attributed entries.

### TC-19 – Responsive Popover (768px) + Dark Parity

- **Objective:** Verify editors fit small + dark.
- **Preconditions:** 768px + dark mode.
- **Steps:**
  1. Open stage dropdown/date picker inline; verify not clipped by table overflow, flips above if needed.
  2. Dark: pending shimmer + error red legible (AA).
  3. Touch: tap opens, Save/Cancel reachable.
- **Expected:** No clipping; contrast OK.

## 5. UI Steps + localStorage/Network Checks (No curl – Pure Frontend)

Optimistic UI is validated via paint timing + Network, not curl.

| Check             | Steps (DevTools)                        | Expected                                                                                           |
| ----------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Optimistic paint  | Slow 3G, Network preserve, edit + Enter | Cell paints new value while `PATCH` Pending; `performance.now()` delta <50ms                       |
| Single PATCH      | Double-Enter rapidly                    | One `PATCH /api/...` (or coalesced), status 200; one timeline entry                                |
| Esc sends nothing | Edit + `Esc`                            | Zero new Network calls; value restored                                                             |
| Rollback          | Offline + edit                          | Value reverts + toast with Retry; `updatedAt` unchanged via UI detail                              |
| Retry             | Online + click Retry                    | New `PATCH` 200; value reapplies                                                                   |
| Queue key         | `localStorage` inspect                  | If `crm.pendingEdits` (or actual) exists, drains to `[]` after ACK; never leaks other users' edits |
| Viewer block      | Viewer token `fetch PATCH` in console   | `403 Forbidden`; UI affordance absent                                                              |

```js
// DevTools snippets on http://localhost:3000
Object.keys(localStorage).filter(
  (k) => k.toLowerCase().includes('edit') || k.toLowerCase().includes('pending'),
);
JSON.parse(localStorage.getItem('crm.pendingEdits') || '[]'); // adapt key, document actual
performance.now(); // mark before/after Enter to evidence <50ms paint
```

- Document ACTUAL pending-key (or `in-memory only – no localStorage`) after inspection.
- Screenshots: pending shimmer, rollback toast with Retry, Undo toast, validation inline.

## 6. UI Testing Section

- Affordances: hover underline/pencil, focus ring, `Click to edit` tooltip; viewers see none.
- Editors: text input (select-all on open), number with stepper/spinner, select pills + searchable assignee, calendar with Today/Clear, tags chips with ×.
- States: pristine → editing (Save/Cancel or Enter/Esc hints) → pending (spinner/dot, input disabled) → saved (toast+Undo) / error (red border + message + Retry, value rolled back).
- Toasts: `Saved – Undo`, `Couldn't save – Retry`; stacked max 3; auto-dismiss 5s except error persists until Retry/Dismiss.
- Tables: row height stable (no jump), sticky header intact, virtualized rows preserve editors on scroll (or close gracefully – document).
- Dark/a11y: focus visible, editors labeled (`aria-label="Edit amount"`), errors `role=alert`, Esc announces cancel, axe clean.

## 7. Regression & Cross-Feature Impact

- Lists/Detail/Reports: inline write must update detail header, list cell, Home snapshot, and Reports after refresh (same PATCH path as forms).
- Validation: rules shared with full-form + API (single source – verify mismatch filed if any).
- Activity/timeline: every inline save logs actor + old→new.
- Workflows: stage/amount inline edits must fire eligible workflows (same as form edits).
- Search/palette: renamed values searchable within invalidation window.
- Offline: queued inline edits must not corrupt on reconnect (order + rollback preserved).

## 8. Expected Results Summary Table

| TC    | Title             | Expected                    | Severity |
| ----- | ----------------- | --------------------------- | -------- |
| TC-01 | Text happy        | Instant + persists + Undo   | Critical |
| TC-02 | Amount format     | $ format + numeric store    | Major    |
| TC-03 | Stage select      | Pill + timeline, kb+mouse   | Major    |
| TC-04 | Date picker       | Valid saves, invalid blocks | Major    |
| TC-05 | Assignee          | Swap + notify               | Major    |
| TC-06 | Blur/Esc/Enter    | Contract documented         | Major    |
| TC-07 | Optimistic proof  | Paint ≪ ACK                 | Major    |
| TC-08 | Rollback+retry    | Revert + recover            | Critical |
| TC-09 | Validation        | Client+server 400           | Major    |
| TC-10 | Undo window       | Timed revert                | Minor    |
| TC-11 | Concurrent        | Deterministic, no corrupt   | Major    |
| TC-12 | Viewer blocked    | No affordance + 403         | Critical |
| TC-13 | Double-edit queue | No loss                     | Minor    |
| TC-14 | Unicode           | Round-trip                  | Minor    |
| TC-15 | XSS               | Escaped                     | Critical |
| TC-16 | Tab chain         | Excel-like                  | Minor    |
| TC-17 | No double-PATCH   | Single write                | Major    |
| TC-18 | Audit             | Attributed                  | Minor    |
| TC-19 | Responsive/dark   | Fits + AA                   | Minor    |

## 9. Troubleshooting & Common Failures

| Symptom                   | Cause                                                    | Fix                                                                   |
| ------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------- |
| Reverts even online       | PATCH 400/403/500 (validation/auth/bug)                  | Inspect Network response body; fix value/perms; file bug with payload |
| Stuck pending spinner     | ACK never resolves (worker hang) / missing error handler | Check server logs; add timeout + rollback at 10s                      |
| Double timeline entries   | Double-PATCH on Enter+blur both firing                   | Debounce; disable blur-save when Enter already committed              |
| Esc still saves           | Blur-save races Esc                                      | Cancel blur handler when Esc pressed (flag)                           |
| New value lost on scroll  | Virtualized row unmount drops editor                     | Commit on unmount or block scroll while editing                       |
| Amount shows `NaN`        | Parse of `$12,500` with comma fails                      | Strip formatting before parse; verify locale parse                    |
| Conflict silent overwrite | No version/etag check                                    | Add `If-Match: updatedAt` → 409 + banner; document                    |
| Toast Undo dead           | Revert PATCH fails (perms)                               | Surface revert error; keep new value + warning                        |

- Debug: Network `PATCH` payload/response, `updatedAt` before/after, console React warnings, timeline entries.
- Reset: revert QA values; clear pending key; go online + broadband.

## 10. Pass/Fail Checklist

- [ ] Text/number/select/date/assignee all save instantly + persist across reload.
- [ ] Blur/Esc/Enter contract documented with Network proof (Esc sends nothing).
- [ ] Optimism proven (paint ≪ ACK on Slow 3G); double-Enter sends single PATCH.
- [ ] Offline/500 rolls back with Retry toast; Retry recovers; Undo window works.
- [ ] Validation inline + server 400 agree; XSS escaped; unicode round-trips.
- [ ] Concurrent deterministic; viewer blocked (no affordance + 403); rapid edits no loss.
- [ ] Timeline attributed; reports/home reflect after refresh; responsive/dark/a11y pass.
- [ ] Evidence: paint-vs-ACK timings, Network HAR, toast screenshots, storage dump (key documented).
- [ ] Reverted to baseline; defects filed with field, old→new, PATCH bodies.
