# Profile & Settings – Comprehensive Testing Guide

Base URLs: API `http://localhost:3001`, Web `http://localhost:3000`.

## 1. Overview

This guide covers User Profile and Timezone settings: viewing/editing name, avatar, email, password, timezone, locale, and notification-adjacent prefs (deep prefs in `notifications.md`).
Scope includes profile page (`/settings/profile`), avatar upload/remove, name/email change with verification, password change with strength + session handling, timezone selector with date-preview, save/discard, validation, and propagation (Home greeting, Home/report dates, audit actor names).
Out of scope is org settings/billing (see `billing-subscriptions.md`) and per-type notification toggles (see `notifications.md`).
Key roles: Self (edit own), Admin (edit others per policy + read), Other user (cannot edit).
Critical rules: email change requires verification/confirm; password change requires current + invalidates other sessions (or explicit “sign out others”); timezone change immediately alters displayed dates (stored UTC unchanged); avatar ≤5MB image only.
Success criteria: profile edits persist across reload + API, timezone preview accurate, password/email flows secure, and cross-user edits blocked.

## 2. Prerequisites & Test Data Setup

- Stack: Web `:3000`, API `:3001`, mail catcher for email-change verification, object storage for avatars.
- Users: `profile-qa@test.com / Profile123!` (primary), `other@test.com`; admin token; save JWTs.
- Baseline: `GET /api/me` snapshot (`firstName,lastName,email,timezone,avatarUrl`) before edits.
- Fixtures: `avatar.png` (200KB), `avatar-big.jpg` (6MB over-limit), `avatar.txt` (invalid type).
- Timezones to test: `UTC`, `America/New_York`, `Asia/Kolkata`, `Australia/Sydney`; note DST date (e.g., 2026-03-10 US DST).
- Browsers: Chrome + Firefox; second session (incognito) to verify session invalidation.
- Cleanup: revert name/timezone/avatar after run; delete verification emails.

## 3. Test Environment Matrix

| Dimension | Variants                                                     |
| --------- | ------------------------------------------------------------ |
| Field     | First/last name, Avatar, Email, Password, Timezone, Locale   |
| Browser   | Chrome 130+, Firefox 132+                                    |
| Viewport  | 1440px, 375px                                                |
| Role      | Self, Admin editing other, Non-admin editing other (blocked) |
| Timezone  | UTC, NY, Kolkata, Sydney + DST edge                          |
| Avatar    | Valid png/jpg, Oversize, Wrong type, Remove                  |
| Password  | Valid change, Wrong current, Weak new, Reuse old             |
| Client    | UI form, curl API                                            |

- Record: `GET /api/me` before/after each case, screenshot of date rendering, email IDs.
- Verify dates on Home + task due + report close-date after TZ change.

## 4. Detailed Step-by-Step Test Cases (at least 18 numbered TC cases)

### TC-01 – View Profile Shows Current Values

- **Objective:** Verify profile loads with API truth.
- **Preconditions:** Logged in as QA user.
- **Steps:**
  1. Open `http://localhost:3000/settings/profile`.
  2. Compare fields to `GET /api/me` (name, email, TZ, avatar).
  3. Verify avatar image loads (or initials fallback).
  4. Verify Save disabled when pristine.
- **Expected:** Matches API; no `undefined`.

### TC-02 – Edit First/Last Name Persists + Propagates

- **Objective:** Verify name change reflects everywhere.
- **Preconditions:** Name `QA Before`.
- **Steps:**
  1. Change to `QA After`; Save; verify toast.
  2. Reload; verify retained.
  3. Check Home greeting `Hello, QA`, comment author, assignee picker.
  4. Revert.
- **Expected:** Global propagation <30s (or after refresh – document).

### TC-03 – Avatar Upload Valid

- **Objective:** Verify image upload + crop/preview if present.
- **Preconditions:** No custom avatar (initials).
- **Steps:**
  1. Upload `avatar.png`; verify preview + progress + success.
  2. Verify header/sidebar avatar updates without reload (or after reload max).
  3. `GET /api/me.avatarUrl` non-null; open URL → 200 image.
  4. Reload; verify persists.
- **Expected:** Visible everywhere; URL authed or signed per spec (document).

### TC-04 – Avatar Oversize / Wrong Type Rejected

- **Objective:** Verify validation.
- **Preconditions:** Profile open.
- **Steps:**
  1. Upload 6MB jpg → expect `Max 5MB` (confirm limit from impl – record).
  2. Upload `.txt` → `Image only (png/jpg/webp)`.
  3. Verify old avatar retained; no partial upload.
- **Expected:** Inline errors; no 500.

### TC-05 – Avatar Remove Resets to Initials

- **Objective:** Verify removal.
- **Preconditions:** Custom avatar set.
- **Steps:**
  1. Click Remove → confirm; verify initials return + `avatarUrl=null` via API.
  2. Verify old URL 404/expired (no leak).
- **Expected:** Clean removal.

### TC-06 – Timezone Change Alters Displayed Dates (UTC Stored)

- **Objective:** Verify TZ rendering rule.
- **Preconditions:** Task due `2026-09-08T15:00:00Z`.
- **Steps:**
  1. Set TZ `UTC`; note Home/task shows `15:00 UTC`.
  2. Set `Asia/Kolkata`; verify shows `20:30 IST` same instant.
  3. Set `America/New_York`; verify `11:00 EDT`.
  4. Verify API `dueAt` still `…Z` (storage unchanged).
- **Expected:** Same instant, different wall time; storage UTC.

### TC-07 – Timezone Preview + DST Edge

- **Objective:** Verify preview avoids DST surprise.
- **Preconditions:** Date near US DST 2026-03-08.
- **Steps:**
  1. Select `America/New_York`; verify preview `Current time: … EDT` correct.
  2. View task due on DST day; verify hour correct (not off-by-one).
  3. Save; verify Home dates shift accordingly.
- **Expected:** DST correct; preview matches saved.

### TC-08 – Email Change Requires Verification

- **Objective:** Verify secure email swap.
- **Preconditions:** Email `profile-qa@test.com`.
- **Steps:**
  1. Change to `profile-qa-new@test.com`; Save.
  2. Verify state `pendingVerification` + banner + catcher email with link/code.
  3. Login with old still works until verified (document); new not yet.
  4. Click verify; verify email flips + old invalid.
- **Expected:** No unverified takeover; link single-use + expiry.

### TC-09 – Email Change Rejects Invalid/Duplicate

- **Objective:** Verify validation.
- **Preconditions:** Profile open.
- **Steps:**
  1. Enter `not-an-email` → inline error, Save blocked.
  2. Enter existing `other@test.com` → `Email already in use` 409.
  3. Verify current email unchanged.
- **Expected:** 400/409 with codes; no partial.

### TC-10 – Password Change Happy Path + Session Handling

- **Objective:** Verify strength + re-auth semantics.
- **Preconditions:** Know current `Profile123!`.
- **Steps:**
  1. Settings → Change password: current + new `NewProf456!` + confirm.
  2. Verify strength meter + mismatch blocked.
  3. Save; verify success + (stay logged in current + invalidate others OR prompt `Sign out other sessions` – document).
  4. Login with old → fails; new → succeeds.
  5. Revert to original for other tests.
- **Expected:** Old dead, new works; other sessions handled per spec.

### TC-11 – Password Rejects Wrong Current / Weak / Same

- **Objective:** Verify guards.
- **Preconditions:** Same form.
- **Steps:**
  1. Wrong current → `Current password incorrect` 401/400, no change.
  2. Weak `12345` → `Too weak` blocked client + server 400.
  3. New == current → `Must differ` blocked.
- **Expected:** All blocked; no lockout on single fail (document lockout threshold separately).

### TC-12 – Discard / Unsaved-Changes Guard

- **Objective:** Verify dirty tracking.
- **Preconditions:** Edit name without saving.
- **Steps:**
  1. Navigate away; verify `Discard changes?` prompt.
  2. Stay → Save succeeds; Leave → reverts.
  3. Reload pristine → no prompt.
- **Expected:** No silent loss; no nag when clean.

### TC-13 – Locale / Date Format (if present)

- **Objective:** Verify locale affects formatting.
- **Preconditions:** Locale picker if exists.
- **Steps:**
  1. Set `en-US` → `Sep 8, 2026`; `en-GB` → `8 Sep 2026` (adapt to impl).
  2. Verify Home/reports follow.
- **Expected:** Consistent. If absent, N/A.

### TC-14 – Cross-User Edit Blocked (Non-Admin)

- **Objective:** Verify users cannot edit others.
- **Preconditions:** Other user ID known.
- **Steps:**
  1. As QA user `PATCH /api/users/OTHER_ID` → 403.
  2. Open `/settings/profile?userId=OTHER` (if supported) → redirects to own or 403.
- **Expected:** 403; UI has no affordance.

### TC-15 – Admin Edits Other (if supported)

- **Objective:** Verify admin capability + audit.
- **Preconditions:** Admin token.
- **Steps:**
  1. As admin update QA user name/TZ via Admin → Users.
  2. Verify QA user sees change + audit `profile.updated by admin`.
  3. Verify admin cannot change others' password/email without verification flow (document).
- **Expected:** Scoped admin powers; sensitive fields still gated.

### TC-16 – Mobile Profile (375px)

- **Objective:** Verify usable on phone.
- **Preconditions:** 375px.
- **Steps:**
  1. Edit all fields; upload avatar via mobile picker.
  2. Verify TZ dropdown usable, Save reachable.
- **Expected:** No clipped controls.

### TC-17 – Accessibility

- **Objective:** Verify labeled + keyboard.
- **Preconditions:** Keyboard only + axe.
- **Steps:**
  1. Tab through Name/Email/TZ/Avatar/Save; verify labels + focus.
  2. TZ combobox Arrow+Enter works; avatar input has label.
  3. Axe: no critical.
- **Expected:** Full path; announcements on save.

### TC-18 – Concurrent Saves (Two Tabs)

- **Objective:** Verify last-write or conflict handling.
- **Preconditions:** Same profile in two tabs.
- **Steps:**
  1. Tab A sets name `Alpha` (unsaved), Tab B sets `Beta` + Save.
  2. Tab A Saves; verify result is `Alpha` (last-write-wins) or conflict warning per spec – document.
  3. Reload; verify single truth matches API.
- **Expected:** No corruption; deterministic.

### TC-19 – API Negatives & Avatar Auth

- **Objective:** Verify API guards.
- **Preconditions:** Tokens.
- **Steps:**
  1. `PATCH /api/me` anon → 401.
  2. `PATCH` with `timezone: Mars/Olympus` → 400 `unknown timezone`.
  3. `GET avatarUrl` anon → 401/403 or signed-URL expiry per spec (document).
  4. Upload `.exe` via curl → 400.
- **Expected:** Correct 4xx; no 500.

## 5. API Testing Section

| Method & Endpoint           | Purpose                 | Auth             | Notes                  |
| --------------------------- | ----------------------- | ---------------- | ---------------------- |
| `GET /api/me`               | Current profile         | Bearer           | Baseline               |
| `PATCH /api/me`             | Update name/TZ/locale   | Bearer (self)    | `{firstName,timezone}` |
| `POST /api/me/avatar`       | Upload avatar multipart | Bearer (self)    | `file` image ≤5MB      |
| `DELETE /api/me/avatar`     | Remove                  | Bearer (self)    | Nulls URL              |
| `POST /api/me/email-change` | Request swap            | Bearer (self)    | Sends verify           |
| `POST /api/me/email-verify` | Confirm                 | Token/code       | Flips email            |
| `POST /api/me/password`     | Change pw               | Bearer + current | `{current,new}`        |

```bash
# Login
curl -s -X POST http://localhost:3001/api/auth/login -H "Content-Type: application/json" \
  -d '{"email":"profile-qa@test.com","password":"Profile123!"}'
# -> $ME_TOKEN

# 1) Baseline
curl -s http://localhost:3001/api/me -H "Authorization: Bearer $ME_TOKEN" | python3 -m json.tool

# 2) Update name + timezone
curl -s -X PATCH http://localhost:3001/api/me \
  -H "Authorization: Bearer $ME_TOKEN" -H "Content-Type: application/json" \
  -d '{"firstName":"QA","lastName":"After","timezone":"Asia/Kolkata"}' | python3 -m json.tool

# 3) Avatar upload
curl -s -X POST http://localhost:3001/api/me/avatar \
  -H "Authorization: Bearer $ME_TOKEN" -F "file=@/tmp/avatar.png" | python3 -m json.tool

# 4) Request email change
curl -s -X POST http://localhost:3001/api/me/email-change \
  -H "Authorization: Bearer $ME_TOKEN" -H "Content-Type: application/json" \
  -d '{"email":"profile-qa-new@test.com"}' | python3 -m json.tool

# 5) Change password
curl -s -X POST http://localhost:3001/api/me/password \
  -H "Authorization: Bearer $ME_TOKEN" -H "Content-Type: application/json" \
  -d '{"current":"Profile123!","new":"NewProf456!"}' | python3 -m json.tool

# 6) Cross-user must 403
curl -i -X PATCH http://localhost:3001/api/users/OTHER_ID \
  -H "Authorization: Bearer $ME_TOKEN" -H "Content-Type: application/json" -d '{"firstName":"Hijack"}' | head -n 10
```

- Adapt if impl uses `/api/users/me` or `/api/profile`; document actuals.
- Assert: TZ invalid → 400; avatar oversize → 413/400; email dup → 409; anon → 401.

## 6. UI Testing Section

- Layout: `/settings/profile` card with avatar row (preview + Upload/Remove), Name, Email (+Verified/Pending badge + Resend), Timezone combobox with live clock preview, Locale if present, Save/Discard bar (sticky), danger zone (change password).
- Validation: inline per field, Save disabled pristine + spinner pending, toasts `Profile saved` / `Verification sent`.
- Dates preview: `Dates will show as …` updates as TZ changes.
- Responsive: stacks at 375px; avatar actions wrap; Save reachable without scroll-jank.
- A11y/dark: labels, combobox roles, focus visible, dark parity for previews.

## 7. Regression & Cross-Feature Impact

- Home: greeting + dates follow profile immediately (or after refresh – document).
- Reports/Tasks: close/due rendering follows TZ; API storage stays UTC.
- Comments/assignees: display names + avatars update.
- Notifications: email-change verification + password-change alert emails sent.
- Auth: password change session semantics; email change invalidates old login.
- Audit: profile writes logged with actor + diff (excluding password hash).

## 8. Expected Results Summary Table

| TC    | Title               | Expected             | Severity |
| ----- | ------------------- | -------------------- | -------- |
| TC-01 | View matches API    | No undefined         | Minor    |
| TC-02 | Name propagates     | Everywhere           | Major    |
| TC-03 | Avatar valid        | Everywhere + URL 200 | Major    |
| TC-04 | Avatar invalid      | Inline reject        | Minor    |
| TC-05 | Avatar remove       | Initials + 404 old   | Minor    |
| TC-06 | TZ display shift    | Same instant         | Critical |
| TC-07 | DST preview         | Correct hour         | Major    |
| TC-08 | Email verify flow   | Pending→flip         | Critical |
| TC-09 | Email invalid/dup   | 400/409              | Major    |
| TC-10 | Password + sessions | Old dead/new works   | Critical |
| TC-11 | Password guards     | All blocked          | Major    |
| TC-12 | Dirty guard         | Prompt correct       | Minor    |
| TC-13 | Locale              | Or N/A               | Minor    |
| TC-14 | Cross-user 403      | Blocked              | Critical |
| TC-15 | Admin scoped        | Audited              | Major    |
| TC-16 | Mobile              | Usable               | Minor    |
| TC-17 | A11y                | Keyboard + axe       | Minor    |
| TC-18 | Concurrent          | Deterministic        | Minor    |
| TC-19 | API negatives       | 4xx                  | Major    |

## 9. Troubleshooting & Common Failures

| Symptom                                  | Cause                                                     | Fix                                                                     |
| ---------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| TZ change no visual effect               | Cached dates; component uses browser TZ not profile       | Hard reload; check `GET /api/me.timezone` vs rendering source; file bug |
| Avatar 404 after upload                  | Signed URL expired / storage misconfig                    | Check URL expiry; storage backend logs; re-upload                       |
| Email verify link invalid                | Already used/expired; wrong env link (`:3001` vs `:3000`) | Resend; check link host; check TTL                                      |
| Password change logs me out unexpectedly | Global revoke vs per-spec stay                            | Document; re-login; verify other session state                          |
| Name shows old in picker                 | Stale cache                                               | Refresh; check API; clear cache                                         |
| Upload stalls                            | File too large/proxy limit                                | Check size + `client_max_body_size`; retry smaller                      |
| 500 on bad TZ                            | Missing validation                                        | File bug; expect 400 `unknown timezone`                                 |
| Dates off by day                         | UTC midnight + negative offset                            | Store noon UTC for date-only or document rule                           |

- Debug: `GET /api/me` diff, Network PATCH status, catcher message, avatar URL headers, console for picker errors.
- Reset: revert name/TZ/avatar/password; confirm baseline `GET /api/me` matches start.

## 10. Pass/Fail Checklist

- [ ] View matches API; name/avatar/TZ persist + propagate (Home, pickers, comments).
- [ ] TZ shifts display not storage; DST correct; preview accurate.
- [ ] Email change pending→verified; invalid/dup blocked; old/new login semantics proven.
- [ ] Password strength + wrong/weak/same blocked; old dead/new works; sessions per spec.
- [ ] Avatar valid/invalid/remove correct; dirty guard; mobile + a11y pass.
- [ ] Cross-user 403; admin scoped + audited; API negatives 401/400/409.
- [ ] API curls all behave; evidence (me JSON before/after, emails, screenshots light/dark/mobile).
- [ ] Reverted to baseline; defects filed with IDs + payloads.
