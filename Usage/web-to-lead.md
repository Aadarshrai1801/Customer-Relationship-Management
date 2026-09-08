# Web-to-Lead – Comprehensive Testing Guide

## 1. Overview

This guide covers public Web-to-Lead capture: embeddable HTML form snippet, public capture endpoint (no auth), spam protection, and duplicate 5-minute rule.
Scope includes snippet generation/copy, field mapping, CORS/embedding on external site, public POST without token, required validation, honeypot/captcha/rate-limit spam guards, duplicate suppression within 5 minutes (same email), UTM/referrer capture, source auto-tag `Web-to-Lead`, routing trigger, admin moderation queue if any.
Base URLs:

- API: `http://localhost:3001` (capture endpoint e.g., `POST /api/web-to-lead` or `/api/leads/capture`)
- Web: `http://localhost:3000` (snippet generator page + test form)
- Public test page: local `test-web-to-lead.html` embedding snippet via `<script>` or `<iframe>` + direct POST.
  Success criteria: unauthenticated capture creates lead with correct attribution, spam blocked, duplicate within 5 min suppressed (409 or deduped), snippet works cross-origin without auth errors.

## 2. Prerequisites & Test Data Setup

- API health `http://localhost:3001/health`, Web `http://localhost:3000`.
- Admin token for snippet config + verifying leads; no token for public tests (incognito).
- Discover capture endpoint: check docs or `GET /api/web-to-lead/config` or Network tab on snippet page. Assume `POST http://localhost:3001/api/web-to-lead` – adjust if `POST /api/leads/public` or `/api/capture/lead`.
- Get embed snippet from UI: `http://localhost:3000/settings/web-to-lead` -> Copy HTML. Example snippet under test:

```html
<form id="w2l-form" action="http://localhost:3001/api/web-to-lead" method="POST">
  <input type="text" name="firstName" placeholder="First Name" required />
  <input type="text" name="lastName" placeholder="Last Name" required />
  <input type="email" name="email" placeholder="Email" required />
  <input type="text" name="company" placeholder="Company" required />
  <input type="tel" name="phone" placeholder="Phone" />
  <input type="text" name="website" style="display:none" tabindex="-1" autocomplete="off" />
  <input type="hidden" name="utmSource" value="" />
  <input type="hidden" name="utmMedium" value="" />
  <input type="hidden" name="utmCampaign" value="" />
  <button type="submit">Submit</button>
</form>
<script src="http://localhost:3000/w2l.js" data-form="w2l-form"></script>
```

- Create local test page `C:\Temp\w2l-test.html` pasting snippet, serve via `npx serve` or open file:// (note CORS differences).
- Test emails: use `w2l.<timestamp>@test.com` unique per run except duplicate test reuses same.
- Baseline JSON for direct POST:

```json
{
  "firstName": "Web",
  "lastName": "Visitor",
  "email": "w2l.visitor@test.com",
  "company": "Visitor Corp",
  "phone": "+1-415-555-0199",
  "source": "Web-to-Lead",
  "utmSource": "homepage",
  "utmMedium": "web",
  "utmCampaign": "contact_us",
  "referrer": "http://localhost:3000/pricing",
  "pageUrl": "http://example.com/contact"
}
```

- Spam test payloads: honeypot filled, rapid 10 posts same IP, script tag in name.
- Timer for 5-min rule: record first submit `T0`, second at `T0+30s` (suppress), third at `T0+6min` (allow – use wait or manipulate createdAt if test hook exists).
- Cleanup: delete `w2l.*@test.com` leads as Admin.

## 3. Test Environment Matrix

| Dimension      | Variants                                                                                |
| -------------- | --------------------------------------------------------------------------------------- |
| Capture Method | Snippet form submit, direct POST JSON, form-urlencoded, iframe embed                    |
| Auth           | No token (public), invalid token, expired token – all must work same (no auth required) |
| Browsers       | Chrome, Firefox, Safari (snippet JS)                                                    |
| Hosting        | Same-origin `localhost:3000`, cross-origin `example.com:8080`, file://                  |
| Network        | Normal, adblocker on, JS disabled (fallback native POST), 3G                            |
| Spam Signals   | Clean, honeypot filled, rate burst, disposable email, XSS payload                       |
| Duplicates     | First submit, repeat <5min, repeat >5min, different email same company                  |

- Record endpoint URL actually used (may differ from assumption – update this doc).
- Test both JSON and form-urlencoded as snippet may send either.

## 4. Detailed Step-by-Step Test Cases

### TC01 – Snippet Generation & Copy (UI)

- Steps as Admin: Open `http://localhost:3000/settings/web-to-lead`, verify snippet preview, click Copy, paste into notepad.
- Expected: Snippet contains correct action URL `http://localhost:3001/api/web-to-lead`, required fields, honeypot field, UTM hidden fields, JS link if any. Copy toast shown. Snippet regenerates with new token/key if rotated.

### TC02 – Public Form Submit Happy Path (Embedded)

- Steps: Open local test page embedding snippet, fill First/Last/Email/Company/Phone, Submit.
- Expected: Success message `Thanks! We'll be in touch` without login, no CORS error in console, lead appears in CRM within 5s with source `Web-to-Lead` and correct field values.

### TC03 – Direct Public POST JSON (No Auth)

- Steps: `POST http://localhost:3001/api/web-to-lead` with baseline JSON, no Authorization header.
- Expected: `201` with lead id, `source: Web-to-Lead`. `GET /api/leads/:id` as Admin confirms. Response does not leak internal fields (no owner salary etc.).

### TC04 – Direct POST Form-Urlencoded

- Steps: Send same data as `application/x-www-form-urlencoded` (as native form would).
- Expected: `201` same as JSON. Both content-types supported. Verify special chars `O'Neil & Co.` preserved.

### TC05 – Required Field Validation Public

- Steps: Submit missing lastName, missing company, missing email, invalid email `bad@`.
- Expected: `400` with field errors JSON + inline form errors without page reload (if JS). No lead created. Error messages user-friendly, not stack trace.

### TC06 – Honeypot Spam Block

- Steps: Submit with honeypot `website` filled (`http://spam.com`) – bots fill hidden field.
- Expected: Request appears success to bot (`200 Thanks`) but no lead created (silent drop) OR `400 spam detected` – document behavior. Verify `GET /api/leads?search=spam` 0 results. No notification sent.

### TC07 – Rate Limit / Burst Spam Block

- Steps: Send 10 rapid POSTs same email/IP within 10s via script loop.
- Expected: First 1-2 succeed, rest `429 Too Many Requests` with `Retry-After` header. Leads count does not spike to 10. UI form disables Submit for 30s after rapid clicks.

### TC08 – Duplicate 5-Minute Rule – Suppressed

- Steps:
  1. POST `w2l.dup5@test.com` at T0 – expect 201, record id A.
  2. POST same email (different case `W2L.DUP5@test.com`) at T0+30s with slightly different company.
- Expected: Second returns `409 Duplicate within 5 minutes` or `200 deduplicated` with same id A (no new record). Leads search shows 1 record. Response message explains `Already received, we'll be in touch`.

### TC09 – Duplicate After 5 Minutes Allowed

- Steps: POST same email at T0+6min (wait or adjust clock/test hook `?__forceTime=` if available, else document manual wait).
- Expected: New lead created (id B) or existing updated with new submission (per spec – document). If updated, verify timeline shows second submission. If new, verify 2 records same email allowed after window.

### TC10 – Different Email Same Company Not Deduped

- Steps: POST `person1@sameco.com` then `person2@sameco.com` same company within 1 min.
- Expected: Both `201` distinct ids. Dedup key is email only, not company/phone. Verify.

### TC11 – UTM + Referrer Attribution Capture

- Steps: Submit via test page URL with query `?utm_source=google&utm_medium=cpc&utm_campaign=q3&utm_term=crm&utm_content=btn` and referrer header.
- Expected: Lead `utmSource=google` etc. persisted exactly, `referrer/pageUrl` stored if supported. CRM detail shows Attribution section. Direct POST with UTM JSON also works.

### TC12 – Source Auto-Tag Enforcement

- Steps: POST with `source: Cold Call` or omit source.
- Expected: Stored source forced to `Web-to-Lead` regardless of input (or accepted but flagged). Verify filter `source=Web-to-Lead` finds it. Spoofing source via public endpoint not allowed.

### TC13 – XSS & Injection via Public Form

- Steps: Submit firstName `<script>alert(1)</script>`, company `'; DROP TABLE leads; --`, note/message with emoji + 5000 chars.
- Expected: Stored escaped, rendered safe in CRM list/detail (no alert), no SQL error (parameterized), `400` if length exceeds limit with clear message. Check Network response has escaped or raw but UI escapes.

### TC14 – CORS Cross-Origin Embed

- Steps: Host test page on different port (e.g., `http://127.0.0.1:8080`) embedding snippet pointing to `localhost:3001`, submit, check console.
- Expected: No `CORS blocked` error, `Access-Control-Allow-Origin: *` or allowlist includes tester. Preflight OPTIONS returns 204 with `Allow: POST`. If restricted, document allowed origins config.

### TC15 – JS Disabled Fallback

- Steps: Disable JS, submit native form POST to capture endpoint.
- Expected: Browser navigates to success page or JSON `201` rendered (not blank 500). Graceful redirect to `?success=1` or configured return URL.

### TC16 – File Upload / Large Payload Rejection

- Steps: Try attaching 5MB file or 1MB text field via public endpoint.
- Expected: `413 Payload Too Large` or `400` with limit message. No lead created with truncated data. Normal 2KB payload unaffected.

### TC17 – Routing Triggered for Web-to-Lead

- Steps: Ensure active routing rule matches (e.g., source Web-to-Lead -> RR). Submit public lead, check owner + log.
- Expected: Owner auto-assigned (not null), assignment log entry, notification <60s. Fallback queue if no reps available – still creates lead.

### TC18 – Public Endpoint Does Not Expose Private Data

- Steps: `GET http://localhost:3001/api/web-to-lead` (list attempt), `GET /api/leads` without token, `OPTIONS` probe.
- Expected: `GET` list returns `405 Method Not Allowed` or `401`, only POST allowed. Error does not enumerate users. Security headers present (`X-Content-Type-Options`, no `X-Powered-By` leak if hardened).

### TC19 – Success Message & Double-Submit Guard

- Steps: On test page double-click Submit rapidly.
- Expected: Button disables + spinner, single lead created (second suppressed by 5-min rule or idempotency). Success message persists, form clears. Refresh does not resubmit (PRG pattern or JS prevent).

### TC20 – Admin Moderation / Spam Queue (If Exists)

- Steps: Submit spam-suspect lead (disposable email `test@mailinator.com` + honeypot edge), check Admin `Web-to-Lead -> Review` queue.
- Expected: If moderation exists, lead flagged `Needs Review` not auto-routed; Admin can Approve (routes) or Reject (deletes). If no moderation, document as N/A with screenshot of direct creation.

### TC21 – Snippet Key Rotation (Bonus)

- Steps: As Admin rotate embed key/token, old snippet submit vs new snippet submit.
- Expected: Old returns `401 Invalid site key` after rotation, new succeeds. Docs explain rotation without downtime (grace period if any).

### TC22 – Performance – 50 Concurrent Public Submits (Bonus)

- Steps: Script 50 parallel POSTs unique emails.
- Expected: All `201` within 10s, no 500, no lost writes, routing distributes. Check `total` count +50.

## 5. API Testing Section

| Method & Endpoint                         | Purpose                  | Expected                                         |
| ----------------------------------------- | ------------------------ | ------------------------------------------------ |
| `POST /api/web-to-lead`                   | Public capture (no auth) | 201, 400 validation, 409 dup5min, 429 rate-limit |
| `GET /api/leads?search=w2l` (admin)       | Verify created           | 200 found, source Web-to-Lead                    |
| `GET /api/routing/log?leadId=`            | Verify routing fired     | 200 entry                                        |
| `GET /api/web-to-lead/config` (if exists) | Snippet config           | 200 snippet HTML/JS                              |

```bash
# 1. Public capture JSON (NO auth header)
curl -X POST http://localhost:3001/api/web-to-lead \
  -H "Content-Type: application/json" \
  -d '{
    "firstName":"Web","lastName":"Visitor",
    "email":"w2l.visitor@test.com","company":"Visitor Corp",
    "phone":"+1-415-555-0199",
    "utmSource":"homepage","utmMedium":"web","utmCampaign":"contact_us",
    "referrer":"http://localhost:3000/pricing",
    "pageUrl":"http://example.com/contact"
  }'

# 2. Form-urlencoded variant (native form)
curl -X POST http://localhost:3001/api/web-to-lead \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "firstName=Web&lastName=Form&email=w2l.form@test.com&company=FormCo&phone=%2B91-98200-11111"

# 3. Duplicate within 5 min (expect 409 or deduped 200 same id)
curl -X POST http://localhost:3001/api/web-to-lead \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Web","lastName":"Visitor","email":"w2l.visitor@test.com","company":"Visitor Corp2"}'

# 4. Honeypot spam (expect silent 200 no-create OR 400 spam)
curl -X POST http://localhost:3001/api/web-to-lead \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Spam","lastName":"Bot","email":"spam.bot@test.com","company":"SpamCo","website":"http://spam.com"}'

# 5. Invalid email (expect 400, no creation)
curl -X POST http://localhost:3001/api/web-to-lead \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Bad","lastName":"Email","email":"not-an-email","company":"Test"}'

# 6. Verify as admin that lead exists with source Web-to-Lead
curl "http://localhost:3001/api/leads?search=w2l.visitor" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 7. Rate-limit burst (run 10x quickly, expect 429 after threshold)
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3001/api/web-to-lead \
    -H "Content-Type: application/json" \
    -d "{\"firstName\":\"Burst\",\"lastName\":\"Test$i\",\"email\":\"w2l.burst$i@test.com\",\"company\":\"BurstCo\"}"
done
```

- If endpoint is `POST /api/leads/capture` or `/api/capture/lead`, replace path and re-run all.
- Check CORS: `curl -i -X OPTIONS http://localhost:3001/api/web-to-lead -H "Origin: http://example.com"`.

## 6. UI Testing Section

- Snippet page: syntax-highlighted HTML, Copy button, Preview form, field toggles (show/hide phone), UTM auto toggle, Return URL input, Save regenerates snippet.
- Embedded form: labels, required asterisks, email keyboard on mobile, inline errors, success banner green with check icon, error banner red with retry, honeypot hidden (verify `display:none` + `tabindex=-1` + `aria-hidden=true`).
- CRM list: `Web-to-Lead` badge distinct color, Attribution columns, filter by source works, new lead appears without refresh within 5s or after refresh.
- Detail: banner `Created via Web-to-Lead`, referrer/pageUrl links clickable, UTM read-only.
- Responsive: snippet form stacks on mobile, button full-width, no overflow at 360px.
- A11y: form labels associated, errors announced, success focus moved to banner, contrast AA.

## 7. Regression & Cross-Feature Impact

- Leads list/search: public leads appear same as manual, duplicate rule does not affect manual `POST /api/leads` (only public endpoint enforces 5-min).
- Routing: public leads route same as UI leads – verify fallback when all OOO.
- Territories: web lead with email domain matching territory suggests owner – precedence vs routing logged.
- Dashboard: Web-to-Lead source widget + funnel increments; spam-blocked does not increment.
- Notifications: assigned rep notified <60s for public leads too.
- Conversion: web lead can be qualified + converted same as others.
- Security: public endpoint rate-limit does not throttle authed `POST /api/leads` (separate limiter).

## 8. Expected Results Summary Table

| TC   | Title             | Expected           | Pass Criteria      |
| ---- | ----------------- | ------------------ | ------------------ |
| TC01 | Snippet copy      | Correct action URL | Paste works        |
| TC02 | Embed happy       | Success msg + lead | Source Web-to-Lead |
| TC03 | JSON no-auth      | 201                | Admin GET finds it |
| TC04 | Urlencoded        | 201                | Chars preserved    |
| TC05 | Required 400      | Inline +400        | No creation        |
| TC06 | Honeypot          | Silent drop /400   | 0 leads            |
| TC07 | Burst 429         | Retry-After        | No spike           |
| TC08 | Dup <5min         | 409/deduped        | 1 record           |
| TC09 | Dup >5min         | New/updated        | Documented         |
| TC10 | Diff email        | 2 records          | Key=email          |
| TC11 | UTM               | Exact persist      | Detail shows       |
| TC12 | Source forced     | Web-to-Lead        | Filter finds       |
| TC13 | XSS safe          | Escaped            | No alert           |
| TC14 | CORS cross-origin | No blocked         | OPTIONS 204        |
| TC15 | No-JS fallback    | Redirect/success   | No 500             |
| TC16 | Large 413         | Limit msg          | No truncate        |
| TC17 | Routing fires     | Owner+log          | Notify <60s        |
| TC18 | No list leak      | 405/401            | No enum            |
| TC19 | Double-click      | Single lead        | Button disables    |
| TC20 | Moderation        | Review queue       | Approve routes     |
| TC21 | Key rotation      | Old 401 new 201    | Docs grace         |
| TC22 | 50 parallel       | All 201 <10s       | +50 count          |

## 9. Troubleshooting & Common Failures

- `404 /api/web-to-lead`: endpoint path differs – inspect snippet action URL and Network tab; try `/api/leads/public`, `/api/capture/lead`, `/api/forms/:id/submit`; update doc.
- CORS `blocked by CORS policy`: API `CORS_ORIGIN` missing tester origin – add `http://127.0.0.1:8080` or `*` for public route only; verify `Access-Control-Allow-Origin` response header.
- `400 source invalid`: public payload includes `source` enum mismatch – omit source (server forces Web-to-Lead) and retry.
- Duplicate test always 201 (no 409): window is per exact email lowercase + endpoint is authed `/api/leads` not public – ensure using public endpoint and same email case-insensitive within 5 min.
- Honeypot still creates lead: field name mismatch (`website` vs `company_website` vs `hp`) – view snippet source for actual honeypot name; fill that.
- Rate limit never triggers: limiter per IP behind proxy shows `::1` – check `X-Forwarded-For` handling; try faster burst (20 in 2s).
- UTM all null: snippet JS reads `window.location.search` but test page URL had no query – append `?utm_source=...` to page URL, not form action; verify hidden inputs filled before submit via devtools.
- Success but lead not in CRM: created in different org/env (staging vs local DB) – check action URL host (`3001` vs staging), verify via same API host `GET /api/leads?search=`.
- Email stub not received for public lead: routing failed (no owner) so no notify – check owner first, then notifications.
- `413` on normal payload: proxy body limit too low (e.g., 10KB) – increase `BODY_LIMIT` for public route or reduce test message length.

## 10. Pass/Fail Checklist

- [ ] TC01 snippet contains correct action + honeypot + UTM fields, copy works
- [ ] TC02–TC04 embed + JSON + urlencoded all create `Web-to-Lead` leads without auth
- [ ] TC05 validations return 400 + inline errors, no creation, no stack trace
- [ ] TC06 honeypot silently drops or 400s with zero leads + zero notifies
- [ ] TC07 burst returns 429 with Retry-After, no count spike
- [ ] TC08 duplicate <5min suppressed (409/deduped, 1 record)
- [ ] TC09 duplicate >5min creates/updates per spec (documented)
- [ ] TC10 different emails same company both succeed
- [ ] TC11 UTM/referrer persisted exactly and shown read-only
- [ ] TC12 source forced to Web-to-Lead, spoof blocked
- [ ] TC13 XSS/SQL payloads escaped, no execution, length limits enforced
- [ ] TC14 cross-origin succeeds, OPTIONS 204, no CORS error
- [ ] TC15 JS-disabled fallback shows success, no 500
- [ ] TC16 large payload 413, no truncation
- [ ] TC17 routing + notification fire for public leads
- [ ] TC18 GET list blocked (405/401), no enumeration
- [ ] TC19 double-click creates single lead, PRG/no-resubmit
- [ ] TC20 moderation queue handled or marked N/A with evidence
- [ ] TC21 key rotation old 401/new 201 (or N/A)
- [ ] TC22 50 parallel all 201 <10s
- [ ] All 7 curl groups executed, endpoint path confirmed
- [ ] Regression: manual leads, routing, territories, dashboard unaffected
- [ ] Cleanup: `w2l.*@test.com` deleted
- Tester: _______________ Date: _______________ Endpoint: _______________ Result: PASS / FAIL
