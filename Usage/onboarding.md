# Onboarding – Comprehensive Testing Guide

Base URLs: API `http://localhost:3001`, Web `http://localhost:3000`.

## 1. Overview

This guide covers Setup Checklist (Invite team / Connect email / Create pipeline / Import data / Create first deal), Progress tracking, Welcome Wizard, and Time-to-First-Value (<10min TTFV).
Scope includes new-org signup, wizard steps with skip/back, checklist auto-completion detection, progress bar %, invite flow, email connect (OAuth/mock), pipeline creation from template, CSV import entry, first-deal creation, sample-data toggle, and completion celebration.
Out of scope is billing checkout (see `billing-subscriptions.md`), but trial mention in wizard is checked.
Key roles: New Owner/Admin (full checklist), Invited Member (abbreviated), Returning user (checklist dismissed).
Critical rules: checklist reflects real state (no false ticks); progress = completed/total; wizard completable <10min with realistic data; skipping never blocks app use; sample data removable.
Success criteria: fresh org reaches first deal + checklist ≥80% within 10 minutes, progress persists across reloads, and invites/imports initiated from wizard actually work.

## 2. Prerequisites & Test Data Setup

- Fresh orgs: ability to create new org (`POST /api/orgs` or signup UI) – prepare 3 slots (`QA-Onboard-1/2/3`); record org IDs.
- Users: owner `onboard-owner@test.com`, invitee `onboard-invitee@test.com` (fresh inboxes / `+alias` addresses).
- Fixtures: `sample-contacts.csv` (20 rows), logo png (1MB), pipeline template names.
- Mail catcher for invites; OAuth email-connect stubbed or mock (`Connect test mailbox` button – document).
- Browser: incognito for first-run; stopwatch for TTFV; viewport 1440px + 375px.
- API tokens: owner JWT after signup; save.
- Baseline: checklist definition `GET /api/onboarding/checklist` (5 items: invite/email/pipeline/import/deal + welcome).
- Cleanup: delete QA orgs or leave tagged `qa-` for teardown script.

## 3. Test Environment Matrix

| Dimension      | Variants                                                       |
| -------------- | -------------------------------------------------------------- |
| Entry          | Fresh signup, Invite accept, Existing org new user             |
| Wizard         | Full path, Skip-all, Back/forward, Refresh mid-step            |
| Checklist item | Invite, Email connect, Pipeline, Import, Deal (each done/skip) |
| Browser        | Chrome, Firefox; 1440px, 375px mobile                          |
| Data           | Sample data ON, Real CSV, Empty manual                         |
| Email connect  | OAuth mock success, Failure/cancel, Skip                       |
| Timing         | Stopwatch TTFV <10min                                          |
| Client         | UI wizard, curl checklist API                                  |

- Record: org ID, start/end timestamps, per-item completion times, invite IDs.
- Test both sample-data and from-scratch paths.
- Verify returning login does not re-show wizard.

## 4. Detailed Step-by-Step Test Cases (at least 18 numbered TC cases)

### TC-01 – Welcome Wizard Appears for Fresh Org

- **Objective:** Verify first-run wizard launches.
- **Preconditions:** Brand-new org owner, first login.
- **Steps:**
  1. Sign up / create org `QA-Onboard-1`.
  2. Verify redirect to `/welcome` or modal with steps + progress + Skip.
  3. Verify steps listed: Welcome → Invite → Email → Pipeline → Import → Deal.
  4. Close tab, reopen; verify wizard resumes (not lost).
- **Expected:** Wizard greets by name/org; resume works.

### TC-02 – Complete Wizard Happy Path (TTFV <10min)

- **Objective:** Measure end-to-end time to first deal.
- **Preconditions:** Fresh org, stopwatch, fixtures ready.
- **Steps:**
  1. Start timer at wizard Welcome → Next.
  2. Invite 1 teammate (enter email, send).
  3. Connect email via mock (1 click).
  4. Create pipeline from template `Sales` (accept defaults).
  5. Import `sample-contacts.csv` (map + run).
  6. Create deal `First Win [QA]` $5000.
  7. Stop timer at checklist ≥4/5 + deal visible on Home.
- **Expected:** Total <10:00; each step <2min; no blocking errors.

### TC-03 – Checklist Item: Invite Team Auto-Ticks

- **Objective:** Verify invite sent ticks Invite.
- **Preconditions:** Fresh org, catcher open.
- **Steps:**
  1. Note Invite unchecked.
  2. Send invite to `+alias` from wizard AND from Settings → Members.
  3. Verify catcher email + checklist ticks within 30s.
  4. Accept invite in incognito; verify member joins + checklist stays ticked.
- **Expected:** Auto-detect, not manual checkbox.

### TC-04 – Checklist Item: Connect Email

- **Objective:** Verify email connect ticks (or skip honest).
- **Preconditions:** Email-connect mock.
- **Steps:**
  1. Click Connect → mock OAuth allow.
  2. Verify success state + checklist tick + Settings shows Connected.
  3. Disconnect; verify unticks (or stays with `Disconnected` warning – document).
  4. Fail path: Cancel OAuth → verify stays unticked with Retry, no false tick.
- **Expected:** Truthful state; cancel does not tick.

### TC-05 – Checklist Item: Create Pipeline

- **Objective:** Verify pipeline creation ticks.
- **Preconditions:** No custom pipeline yet (or sample only).
- **Steps:**
  1. From wizard choose template Sales → Create.
  2. Verify Pipelines page shows stages; checklist ticks.
  3. Delete pipeline; verify unticks (document if sticky).
- **Expected:** Tick on real creation.

### TC-06 – Checklist Item: Import Data

- **Objective:** Verify import run ticks.
- **Preconditions:** `sample-contacts.csv`.
- **Steps:**
  1. Upload via wizard Import step; map Name/Email; Run.
  2. Verify job Success + contacts appear; checklist ticks.
  3. Verify failed-rows case (bad CSV) does NOT tick until success (or ticks attempted – document).
- **Expected:** Only successful import ticks (preferred).

### TC-07 – Checklist Item: Create First Deal

- **Objective:** Verify first deal ticks + appears on Home.
- **Preconditions:** Pipeline exists.
- **Steps:**
  1. Create deal from wizard (name, amount, stage, contact link).
  2. Verify Deals list + Home Fresh Deals show it; checklist ticks.
  3. Delete deal; verify behavior (untick or stay – document).
- **Expected:** Tick + Home reflection.

### TC-08 – Progress Bar Math

- **Objective:** Verify % = done/total.
- **Preconditions:** 5-item checklist.
- **Steps:**
  1. Complete 0 → 0%, 1 → 20%, 3 → 60%, 5 → 100% (allow welcome-step nuance – document denominator).
  2. Verify API `GET /checklist` `completedCount/total/progressPct` matches UI.
  3. Complete out of order; verify still counts.
- **Expected:** Math exact; API=UI.

### TC-09 – Skip / Back / Remind-Later

- **Objective:** Verify skipping never blocks.
- **Preconditions:** Fresh org mid-wizard.
- **Steps:**
  1. Skip Email step → verify checklist shows `Skipped` (not ticked) and app usable.
  2. Back to previous step; verify inputs retained.
  3. Dismiss wizard (`X` / Do later); verify Home usable + checklist widget remains with Resume.
- **Expected:** Non-blocking; resume available.

### TC-10 – Refresh Mid-Wizard Persists

- **Objective:** Verify state survives reload.
- **Preconditions:** At step 3 with invite entered.
- **Steps:**
  1. Hard reload.
  2. Verify returns to same step with inputs + completed ticks intact.
  3. Complete remaining; verify no duplicate invites/pipelines.
- **Expected:** Server-persisted progress; no dupes on resume.

### TC-11 – Sample Data Toggle + Purge

- **Objective:** Verify sample data ускоряет TTFV and removes cleanly.
- **Preconditions:** Fresh org with `Use sample data` option.
- **Steps:**
  1. Enable sample; verify deals/contacts/activities appear + relevant ticks (document which auto-tick).
  2. Click Remove sample data; verify counts return to 0 and ticks untick accordingly.
  3. Verify no orphan sample notifications.
- **Expected:** Clean add/remove; counts exact.

### TC-12 – Invited Member Sees Abbreviated Onboarding

- **Objective:** Verify invitee path differs from owner.
- **Preconditions:** Invite sent to fresh user.
- **Steps:**
  1. Accept invite; verify wizard shows `Welcome to <org>` with profile/timezone + product tour (not billing/pipeline admin steps).
  2. Verify checklist hidden or personal (e.g., `Complete profile, View first deal`).
  3. Verify no admin CTAs (create pipeline) for member if RBAC restricts.
- **Expected:** Role-appropriate onboarding.

### TC-13 – Returning User No Wizard

- **Objective:** Verify wizard does not nag.
- **Preconditions:** Completed/dismissed org.
- **Steps:**
  1. Logout/login; verify lands on Home, no wizard popup.
  2. Verify checklist widget collapsible, not modal.
  3. Verify `Replay tour` link still available in Help menu (if present).
- **Expected:** No repeat modal; tour replay optional.

### TC-14 – Mobile Wizard (375px)

- **Objective:** Verify wizard usable on phone.
- **Preconditions:** 375px viewport.
- **Steps:**
  1. Walk all steps on mobile; verify inputs/buttons reachable, no horizontal scroll.
  2. Upload CSV via mobile picker (or skip gracefully).
  3. Create deal; verify TTFV still <15min on mobile (note relaxed budget).
- **Expected:** Usable; steps stack.

### TC-15 – Validation Per Step

- **Objective:** Verify inline errors, no dead-ends.
- **Preconditions:** Wizard open.
- **Steps:**
  1. Invite invalid email `not-an-email` → inline error, Next blocked.
  2. Deal without name/amount → blocked with hints.
  3. Import wrong file type `.exe` → rejected with message.
- **Expected:** Clear errors; back always allowed.

### TC-16 – Welcome Email + Invite Email Content

- **Objective:** Verify transactional emails.
- **Preconditions:** Catcher.
- **Steps:**
  1. After signup verify welcome email with login + help links.
  2. After invite verify invite email with org name + Accept link (expiry noted).
  3. Click expired/used invite link → graceful `Expired – request new` page.
- **Expected:** Correct links; expiry handled.

### TC-17 – Timezone/Locale in Wizard (if asked)

- **Objective:** Verify profile defaults captured.
- **Preconditions:** Fresh user.
- **Steps:**
  1. If wizard asks timezone, select `Asia/Kolkata`; verify saved to profile + Home dates render accordingly.
  2. Verify API `GET /api/me` reflects choice.
- **Expected:** Saved; dates localize. If not asked, N/A.

### TC-18 – Completion Celebration + Next Steps

- **Objective:** Verify 100% state delights and guides.
- **Preconditions:** 5/5 complete.
- **Steps:**
  1. Verify confetti/modal `You're set!` + buttons `Go to pipeline / Invite more / View reports`.
  2. Dismiss; verify checklist shows 100% + collapses.
  3. Verify Home greeting personalizes (`Welcome back, <name>`).
- **Expected:** Celebratory but dismissible; deep links work.

### TC-19 – Negative: Duplicate Org / Invite Spam Guard

- **Objective:** Verify abuse guards.
- **Preconditions:** Valid owner.
- **Steps:**
  1. Create org with duplicate name → allowed with unique slug (or blocked – document).
  2. Send 10 invites rapidly to same email → expect dedupe/rate-limit (`1 invite pending` + 429 on spam).
  3. Import 100MB CSV → 413 with message.
- **Expected:** Guarded; no 500; no duplicate orgs breaking routing.

## 5. API Testing Section

| Method & Endpoint                           | Purpose          | Auth           | Notes                                    |
| ------------------------------------------- | ---------------- | -------------- | ---------------------------------------- |
| `POST /api/orgs` or `/api/auth/signup`      | Create fresh org | None/Bearer    | Returns org + owner                      |
| `GET /api/onboarding/checklist`             | Progress         | Bearer         | `items[{key,done,skipped}], progressPct` |
| `POST /api/onboarding/complete` or per-item | Tick/skip        | Bearer         | Prefer auto-detect; manual only if spec  |
| `POST /api/invites`                         | Invite           | Bearer (owner) | Creates pending invite                   |
| `POST /api/pipelines`                       | Create pipeline  | Bearer         | Ticks pipeline                           |
| `POST /api/imports`                         | Upload CSV       | Bearer         | Ticks import on success                  |
| `POST /api/deals`                           | First deal       | Bearer         | Ticks deal                               |

```bash
# 1) Signup fresh org (adapt to implementation)
curl -s -X POST http://localhost:3001/api/auth/signup -H "Content-Type: application/json" \
  -d '{"name":"QA Owner","email":"onboard-owner-qa1@test.com","password":"Owner123!","orgName":"QA-Onboard-1"}' | python3 -m json.tool
# -> save $OWNER_TOKEN

# 2) Checklist baseline (expect 0%)
curl -s http://localhost:3001/api/onboarding/checklist -H "Authorization: Bearer $OWNER_TOKEN" | python3 -m json.tool

# 3) Invite (ticks invite when sent)
curl -s -X POST http://localhost:3001/api/invites -H "Authorization: Bearer $OWNER_TOKEN" \
  -H "Content-Type: application/json" -d '{"email":"onboard-invitee-qa1@test.com","role":"member"}' | python3 -m json.tool

# 4) Create pipeline from template
curl -s -X POST http://localhost:3001/api/pipelines -H "Authorization: Bearer $OWNER_TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"Sales","stages":["Qualification","Proposal","Negotiation","Closed Won","Closed Lost"]}' | python3 -m json.tool

# 5) First deal (needs pipelineId + stage)
curl -s -X POST http://localhost:3001/api/deals -H "Authorization: Bearer $OWNER_TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"First Win [QA api]","amount":5000,"pipelineId":"PIPE_ID","stage":"Qualification"}' | python3 -m json.tool

# 6) Re-check progress (expect increased)
curl -s http://localhost:3001/api/onboarding/checklist -H "Authorization: Bearer $OWNER_TOKEN" | python3 -m json.tool
```

- Assert: each creation flips corresponding `done:true`; `progressPct` math; invite accept does not untick.
- If routes differ, discover via Network tab during wizard and document actuals here.

## 6. UI Testing Section

- Wizard: stepper with states (done/current/todo/skipped), Back/Next/Skip, progress %, contextual help links, estimated time (`~5 min left`).
- Checklist widget: Home/sidebar card with 5 rows (icon, label, CTA, state), progress bar, Resume links per row, Dismiss + Reopen.
- Forms: invite email chips with validation, email-connect button states (Connect/Connected/Failed-Retry), pipeline template cards with preview, import mapper, deal quick-create.
- Celebrations: completion modal with confetti (prefers-reduced-motion respected), deep-link buttons.
- Empty/loading: skeleton on checklist fetch; offline shows `Reconnect to update progress`.
- Responsive/a11y: stepper becomes vertical on 375px; focus moves to step heading on Next; axe clean; keyboard completes all steps.

## 7. Regression & Cross-Feature Impact

- Home: greeting + snapshot + focus must reflect wizard creations immediately.
- Members: invite accept → appears in members + assignee pickers.
- Email: connect status gates email-send features (compose warns if disconnected).
- Pipelines/Deals/Imports: wizard-created entities identical to manually created (same APIs, timelines, reports).
- Notifications: invite/welcome emails sent; bell for invitee.
- Billing: trial banner persists through wizard; plan limits still enforced (e.g., seat cap on invites).
- Sample data: purge must also clear related notifications/reports caches.

## 8. Expected Results Summary Table

| TC    | Title             | Expected              | Severity |
| ----- | ----------------- | --------------------- | -------- |
| TC-01 | Wizard appears    | Greets + resumes      | Major    |
| TC-02 | TTFV <10min       | 5 steps + deal fast   | Critical |
| TC-03 | Invite ticks      | Auto on send          | Major    |
| TC-04 | Email ticks       | Truthful, cancel safe | Major    |
| TC-05 | Pipeline ticks    | On create             | Major    |
| TC-06 | Import ticks      | On success            | Major    |
| TC-07 | Deal ticks + Home | Visible               | Critical |
| TC-08 | Progress math     | Exact API=UI          | Major    |
| TC-09 | Skip/back         | Non-blocking          | Major    |
| TC-10 | Reload persists   | No dupes              | Major    |
| TC-11 | Sample purge      | Clean                 | Minor    |
| TC-12 | Invitee path      | Abbreviated           | Major    |
| TC-13 | No nag return     | Home direct           | Minor    |
| TC-14 | Mobile            | Usable                | Minor    |
| TC-15 | Validation        | Inline, back always   | Minor    |
| TC-16 | Emails            | Links + expiry        | Major    |
| TC-17 | TZ capture        | Saved                 | Minor    |
| TC-18 | Celebration       | Dismissible + links   | Minor    |
| TC-19 | Abuse guards      | Dedupe/429/413        | Major    |

## 9. Troubleshooting & Common Failures

| Symptom                             | Cause                                              | Fix                                                      |
| ----------------------------------- | -------------------------------------------------- | -------------------------------------------------------- |
| Tick stuck false after action       | Auto-detect query wrong (e.g., counts sample data) | Check `GET /checklist` debug + DB counts; file logic bug |
| False tick (skipped counts as done) | `skipped` merged into `done`                       | Separate states; progress counts done only               |
| Wizard loops on reload              | Progress not persisted (localStorage only)         | Persist server-side; check PUT status                    |
| Invite never arrives                | Mailer down / spam                                 | Check catcher/SMTP; resend; check rate-limit 429         |
| Import ticks on failure             | Success flag ignored                               | Gate on `status=success`; file bug                       |
| TTFV >10min                         | Slow import/AI step                                | Profile step timings; allow background import + continue |
| Duplicate pipeline on resume        | Double POST on Next                                | Disable btn pending; idempotency key                     |
| Sample purge leaves ticks           | Ticks not recomputed                               | Recompute on purge; verify counts 0                      |

- Debug: checklist JSON per step, Network PUTs, invite IDs, import job IDs, stopwatch log.
- Reset: new `QA-Onboard-N` org per attempt; never reuse polluted org for TTFV measure.

## 10. Pass/Fail Checklist

- [ ] Fresh org shows wizard; resume after reload; no nag on return.
- [ ] Happy-path TTFV <10min timed with evidence (start/end screenshots).
- [ ] Each checklist item auto-ticks only on real success; progress math exact.
- [ ] Skip/back/dismiss non-blocking; sample add/purge clean.
- [ ] Invitee abbreviated path; mobile usable; validation inline.
- [ ] Welcome + invite emails correct with expiry handling.
- [ ] API checklist progresses via curl; negatives (spam/413) guarded.
- [ ] Evidence: stopwatch log, checklist JSON before/after, emails, Home screenshot.
- [ ] QA orgs tagged/cleaned; defects filed with org IDs + step.
