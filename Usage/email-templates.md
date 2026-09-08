# Email Templates – Comprehensive Testing Guide

## 1. Overview

This guide covers Reusable `{{variable}}` email templates: CRUD, variable definition, rendering with lead/deal/contact/user context, missing-variable handling, preview, versioning, and send-with-template flow. Templates have `subject` + `body` (HTML/text) with `{{firstName}}`, `{{company}}`, `{{dealValue}}`, custom fields, conditionals if supported, and locale variants.
Business rules:

- Rendering is strict in preview (show missing warnings) but configurable on send (`strict|fallback|blank`).
- Unknown `{{var}}` never sent raw in strict mode – send blocked or fallback `""`/`[Missing]`.
- Each render logs `templateId + version + variablesUsed` for audit.
- Updating template creates new version; in-flight sequences keep pinned version unless explicitly upgraded.
  Base URLs:
- API: `http://localhost:3001`
- Web: `http://localhost:3000`

## 2. Prerequisites & Test Data Setup

- Users: admin (manage templates), rep1 (use).
- Seed contacts: Alice (firstName Alice, company Acme, dealValue 5000), Bob (missing company to test fallback).
- Seed templates:
  - `TPL-WELCOME` subject `Hi {{firstName}}`, body `Welcome to {{company}} – {{dealValue}}`.
  - `TPL-FOLLOWUP` with `{{ownerName}}`, `{{bookingLink}}`.
  - `TPL-BROKEN` with `{{unknownVar}}` for negative test.
- Auth tokens for admin + rep1.
- Clean: `GET /api/email-templates` note count; delete `TPL-TEST-*` after run.
- Rendering context endpoint: `POST /api/email-templates/:id/render` with `{leadId|dealId|contactId}`.
- Send flow: `POST /api/emails/send {templateId, leadId}`.

## 3. Test Environment Matrix

| Env                                                                                                            | API                           | Web                   | Notes                        |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------- | ---------------------------- |
| Local                                                                                                          | http://localhost:3001         | http://localhost:3000 | Preview + curl render        |
| CI                                                                                                             | http://localhost:3001         | -                     | Snapshot rendered HTML       |
| Staging                                                                                                        | staging-api                   | staging web           | Real ESP preview, spam score |
| Browsers                                                                                                       | Chrome/Firefox                | Desktop + mobile      | Editor, variable picker      |
| Roles                                                                                                          | admin, rep1 (no delete), rep2 | -                     | Permission matrix            |
| Locales                                                                                                        | en, es (if supported)         | -                     | Fallback locale              |
| Note: XSS payloads tested in isolated template `TPL-XSS`. HTML sanitization verified in preview + sent output. |

## 4. Detailed Step-by-Step Test Cases

### TC01 – Create template with variables

Steps:

1. POST `/api/email-templates` name, subject `Hi {{firstName}}`, body `... {{company}}`.
2. Assert 201, `variablesDetected=[firstName,company]`.
   Expected: Created.

### TC02 – Validation – empty subject/body rejected

Steps:

1. POST missing subject -> 400.
2. POST missing body -> 400.
   Expected: Blocked.

### TC03 – List + search templates

Steps:

1. GET `/api/email-templates?q=welcome`.
2. Verify TPL-WELCOME found, pagination works.
   Expected: Search.

### TC04 – Render with full context (all vars present)

Steps:

1. POST render TPL-WELCOME with LEAD-001 (Alice/Acme).
2. Verify subject `Hi Alice`, body contains Acme + 5000, `missing=[]`.
   Expected: Perfect render.

### TC05 – Render with missing variable – strict warning

Steps:

1. Render TPL-WELCOME with Bob (no company).
2. Verify `missing=[company]`, preview shows highlight `{{company}}` yellow + warning banner.
3. Send with `mode=strict` -> 422 blocked.
   Expected: Strict guards.

### TC06 – Render fallback mode – blank/default

Steps:

1. Render with `mode=fallback`, `defaults={company:"there"}`.
2. Verify body `Welcome to there`, no raw `{{}}`.
3. Send succeeds.
   Expected: Fallback.

### TC07 – Unknown variable detection

Steps:

1. Render TPL-BROKEN `{{unknownVar}}`.
2. Verify `unknown=[unknownVar]`, suggestion `Did you mean?`.
3. Strict send blocked.
   Expected: Unknown flagged.

### TC08 – Whitespace variants `{{ firstName }}` render

Steps:

1. Create template with spaces, tabs, newlines inside braces.
2. Render – must equal trimmed version.
   Expected: Tolerant parser.

### TC09 – Case sensitivity

Steps:

1. Render `{{FirstName}}` vs `{{firstName}}`.
2. Document whether case-insensitive or strict – assert actual per spec.
   Expected: Consistent.

### TC10 – HTML body rendering + escaping

Steps:

1. Template body `<b>Hi {{firstName}}</b>` with firstName `<script>alert(1)</script>`.
2. Verify output escapes script (`&lt;script&gt;`) but keeps `<b>`.
   Expected: XSS-safe.

### TC11 – Preview endpoint (no send)

Steps:

1. POST render with `preview=true`.
2. Verify no email sent (outbox count unchanged), returns html + text.
   Expected: Safe preview.

### TC12 – Send with template – happy path

Steps:

1. POST `/api/emails/send {templateId:TPL-WELCOME, leadId:LEAD-001, to:[alice]}`.
2. Verify email body rendered, `templateId+version` logged, activity linked.
   Expected: End-to-end.

### TC13 – Send with template missing var strict blocked

Steps:

1. Send TPL-WELCOME to Bob strict – expect 422, no email, no activity.
   Expected: No raw send.

### TC14 – Versioning – update creates v2, v1 pinned

Steps:

1. PATCH template body v2.
2. Verify `version=2`, GET `?version=1` returns old.
3. Sequence enrolled on v1 still sends v1 until upgraded.
   Expected: Versioned.

### TC15 – Clone template

Steps:

1. POST `/api/email-templates/:id/clone` new name.
2. Verify copy with `clonedFrom`, variables same, independent edits.
   Expected: Clone.

### TC16 – Delete template – blocked if in use?

Steps:

1. Enroll sequence using TPL-WELCOME, try DELETE -> 409 `in use` OR soft `archived` per spec.
2. Unused TPL delete -> 200.
   Expected: Guard.

### TC17 – Permissions – rep cannot delete/publish

Steps:

1. As rep1 DELETE -> 403; PATCH `isPublished` -> 403.
2. As admin succeeds.
   Expected: RBAC.

### TC18 – Variable picker UI inserts correctly

Steps:

1. Open editor, click `Insert > First Name` – inserts `{{firstName}}` at cursor.
2. Save, verify detected list updates.
   Expected: Picker.

### TC19 – Bulk render 50 leads – performance

Steps:

1. POST `/api/email-templates/:id/render-bulk` with 50 leadIds.
2. Verify all return, missing reported per lead, <3s.
   Expected: Scales.

### TC20 – Locale variant fallback

Steps:

1. Create `es` variant; render with `locale=es` -> Spanish; `locale=fr` (missing) -> falls back `en` + `fallback:true`.
   Expected: Locale fallback.

### TC21 – Conditional block if supported

Steps:

1. Template `{{#if dealValue}}Value: {{dealValue}}{{/if}}`.
2. Render with/without dealValue – verify block shows/hides; if unsupported, verify literal handling documented.
   Expected: Defined behavior.

### TC22 – Audit – render log

Steps:

1. After sends, GET `/api/email-templates/:id/renders?limit=5`.
2. Verify entries with user, lead, version, missing list.
   Expected: Audited.

## 5. API Testing Section

| Method | Endpoint                             | Purpose              | Auth   |
| ------ | ------------------------------------ | -------------------- | ------ |
| POST   | /api/email-templates                 | Create               | Admin  |
| GET    | /api/email-templates                 | List/search          | Bearer |
| GET    | /api/email-templates/:id             | Get + versions       | Bearer |
| PATCH  | /api/email-templates/:id             | Update (new version) | Admin  |
| DELETE | /api/email-templates/:id             | Delete/archive       | Admin  |
| POST   | /api/email-templates/:id/render      | Render single        | Bearer |
| POST   | /api/email-templates/:id/render-bulk | Bulk render          | Bearer |
| POST   | /api/email-templates/:id/clone       | Clone                | Admin  |
| POST   | /api/emails/send                     | Send with templateId | Bearer |
| GET    | /api/email-templates/:id/renders     | Audit log            | Admin  |

Example 1 – Create:

```bash
curl -X POST http://localhost:3001/api/email-templates \
 -H "Content-Type: application/json" -H "Authorization: Bearer $ADMIN_TOKEN" \
 -d '{"name":"Welcome","subject":"Hi {{firstName}}","body":"Welcome to {{company}} – deal {{dealValue}} from {{ownerName}}"}'
```

Example 2 – Render full + missing:

```bash
curl -X POST http://localhost:3001/api/email-templates/TPL_ID/render \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"leadId":"LEAD-001","mode":"strict"}'
curl -X POST http://localhost:3001/api/email-templates/TPL_ID/render \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"leadId":"LEAD-BOB-NOCOMPANY","mode":"fallback","defaults":{"company":"there"}}'
```

Example 3 – Preview (no send):

```bash
curl -X POST http://localhost:3001/api/email-templates/TPL_ID/render \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"leadId":"LEAD-001","preview":true}'
```

Example 4 – Send with template:

```bash
curl -X POST http://localhost:3001/api/emails/send \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"to":["alice@example.com"],"templateId":"TPL_ID","leadId":"LEAD-001","mode":"strict"}'
# strict missing – expect 422
curl -X POST http://localhost:3001/api/emails/send \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"to":["bob@example.com"],"templateId":"TPL_ID","leadId":"LEAD-BOB-NOCOMPANY","mode":"strict"}'
```

Example 5 – Version + clone:

```bash
curl -X PATCH http://localhost:3001/api/email-templates/TPL_ID \
 -H "Content-Type: application/json" -H "Authorization: Bearer $ADMIN_TOKEN" \
 -d '{"body":"Updated body {{firstName}} v2"}'
curl -X POST http://localhost:3001/api/email-templates/TPL_ID/clone \
 -H "Content-Type: application/json" -H "Authorization: Bearer $ADMIN_TOKEN" \
 -d '{"name":"Welcome copy"}'
```

Example 6 – Bulk + audit:

```bash
curl -X POST http://localhost:3001/api/email-templates/TPL_ID/render-bulk \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"leadIds":["LEAD-001","LEAD-002"],"mode":"fallback"}'
curl http://localhost:3001/api/email-templates/TPL_ID/renders?limit=5 -H "Authorization: Bearer $ADMIN_TOKEN"
```

## 6. UI Testing Section

- `http://localhost:3000/templates`: cards with `{{n}} vars`, version badge `v2`, search, Clone/Delete overflow.
- Editor: subject + rich-text body, `Insert variable` dropdown, live preview pane (Desktop/Mobile), missing highlight yellow, `Test with lead` selector.
- Send dialog: mode radio Strict/Fallback, missing list blocks Send in strict.
- Version history drawer: diff v1 vs v2, Rollback button.
- Mobile: editor stacks, preview collapsible.

## 7. Regression & Cross-Feature Impact

- Emails: template send still triggers autolog + BCC dedup; raw `{{}}` must never reach SMTP.
- Sequences: sequence steps reference templateId+version; template update must not silently change live cadence.
- Email-tracking: tracked links inside template body must be rewritten per recipient after render (see email-tracking.md).
- Leads/Deals: custom field rename breaks template – show `stale variable` warning.
- Permissions: template publish/unpublish affects rep send list immediately.

## 8. Expected Results Summary Table

| TC   | Render         | Expected Subject | Missing       | Send Strict               |
| ---- | -------------- | ---------------- | ------------- | ------------------------- |
| TC04 | Full Alice     | Hi Alice         | []            | 202 sent                  |
| TC05 | Bob no company | Hi Bob + warn    | [company]     | 422 blocked               |
| TC06 | Fallback       | Hi Bob, there    | resolved      | 202                       |
| TC07 | Unknown var    | Flag             | [unknownVar]  | 422                       |
| TC10 | XSS name       | Escaped          | -             | Safe HTML                 |
| TC14 | v2 update      | New body         | -             | v1 pinned for old enrolls |
| TC20 | fr locale      | Falls back en    | fallback:true | 202                       |

## 9. Troubleshooting & Common Failures

- Raw `{{firstName}}` in sent email: sent with fallback disabled or direct SMTP bypass – always send via `/emails/send` with mode; check `mode` default (may be blank – set explicitly).
- `422 missing variables` unexpectedly: lead field empty string vs null – both count missing; check lead detail.
- Variables not detected: using single braces `{firstName}` or wrong spacing with special chars – must be double `{{}}`.
- Preview shows old version: cached `?version=` param – hard refresh, check `version` in response.
- XSS stripped too aggressively: sanitizer removes `<b>` – allowlist check; report as bug if formatting lost.
- Clone still linked: edits affect original – clone must deep-copy body, not reference.
- 403 on create: only admin – login admin token, not rep.

## 10. Pass/Fail Checklist

- [ ] Create + validation (TC01-TC02)
- [ ] Search (TC03)
- [ ] Full render (TC04)
- [ ] Missing strict warning + blocked send (TC05)
- [ ] Fallback resolves (TC06)
- [ ] Unknown flagged (TC07)
- [ ] Whitespace tolerant (TC08)
- [ ] Case behavior documented (TC09)
- [ ] XSS escaped (TC10)
- [ ] Preview no-send (TC11)
- [ ] Send happy path logs template (TC12)
- [ ] Strict missing blocked (TC13)
- [ ] Versioning pinned (TC14)
- [ ] Clone independent (TC15)
- [ ] Delete guard (TC16)
- [ ] RBAC (TC17)
- [ ] Picker inserts (TC18)
- [ ] Bulk 50 <3s (TC19)
- [ ] Locale fallback (TC20)
- [ ] Conditional documented (TC21)
- [ ] Audit log (TC22)
- [ ] All curl examples executed
- [ ] UI editor + preview verified
