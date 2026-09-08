# Emails – Comprehensive Testing Guide

## 1. Overview

This guide covers Email send/receive with auto-logging by recipient match, unrecognized-address prompt, and BCC dedup. Outbound via `POST /api/emails/send` logs an email activity if any To/Cc/Bcc matches a lead/contact email. Inbound (webhook/IMAP pull) matches From against CRM contacts. If no match, UI shows `Unrecognized address – Create lead? / Link to existing?` prompt. BCC dedup ensures one activity per `Message-ID`, even if multiple recipients match or BCC’d owner receives copy.
Business rules:

- Match normalized lowercase, trimmed; plus-addressing (`a+tag@`) matches base? Document actual.
- One `Message-ID` => one activity; multiple matching recipients become `linkedContactIds[]`, not multiple activities.
- BCC to CRM tracking address does not create extra activity.
- Unrecognized inbound creates `pendingEmail` queue, not auto-lead.
  Base URLs:
- API: `http://localhost:3001`
- Web: `http://localhost:3000`

## 2. Prerequisites & Test Data Setup

- SMTP stub (Mailhog `http://localhost:8025`) + inbound webhook `POST /api/emails/inbound` with shared secret.
- Contacts: `alice@example.com` (LEAD-001), `bob@example.com` (LEAD-002), `carol@example.com` (no lead – for unrecognized).
- Tracking BCC: `bcc-crm@test.com` configured via `CRM_BCC`.
- Users: rep1 owns LEAD-001, rep2 owns LEAD-002.
- Clean: clear `emails` + `activities?type=email` + `pendingEmails`.
- Get tokens for rep1, rep2, admin.
- Prepare Message-IDs: `msg-001@test`, `msg-002@test` for dedup tests.
- Enable `EMAIL_AUTOLOG=true`, `BCC_DEDUP=true`.

## 3. Test Environment Matrix

| Env                                                                        | Outbound                       | Inbound            | Notes                      |
| -------------------------------------------------------------------------- | ------------------------------ | ------------------ | -------------------------- |
| Local                                                                      | Mailhog                        | Webhook curl       | Deterministic Message-ID   |
| CI                                                                         | Mock SMTP                      | Fixture JSON       | Assert activity counts     |
| Staging                                                                    | SES sandbox                    | Real Gmail forward | SPF/DKIM checks            |
| Browsers                                                                   | Chrome/Firefox                 | -                  | Compose + pending queue UI |
| Roles                                                                      | rep1, rep2, admin              | -                  | Match isolation            |
| Edge                                                                       | Plus-address, case, whitespace | BCC self, multi-To | Normalization              |
| Note: inbound payload shape differs Gmail vs Outlook – test both fixtures. |

## 4. Detailed Step-by-Step Test Cases

### TC01 – Send to recognized contact auto-logs

Steps:

1. As rep1 POST send To alice@example.com subject Hi.
2. Verify 202 + `messageId` returned.
3. GET activities lead LEAD-001 – 1 email activity with `messageId`.
   Expected: Auto-logged.

### TC02 – Send to unrecognized prompts, no auto activity

Steps:

1. Send To `unknown99@test.com`.
2. Verify email sent but no activity created.
3. GET `/api/emails/pending` – entry with `reason=unrecognized`, UI banner `Link?`.
   Expected: Pending, not lost.

### TC03 – Link pending to existing lead

Steps:

1. Take pending from TC02, POST `/api/emails/pending/:id/link` with LEAD-001.
2. Verify activity now appears on LEAD-001, pending cleared.
   Expected: Manual link.

### TC04 – Create lead from pending

Steps:

1. Create new pending to `newbiz@test.com`.
2. POST `/api/emails/pending/:id/create-lead` with name.
3. Verify new lead + activity linked.
   Expected: Quick-create.

### TC05 – Inbound from recognized logs

Steps:

1. POST inbound webhook From alice@example.com To rep1.
2. Verify activity on LEAD-001 `direction=inbound`.
   Expected: Inbound match.

### TC06 – Inbound unrecognized queues

Steps:

1. POST inbound From carol (no lead).
2. Verify pending entry, no activity, UI queue +1.
   Expected: Queued.

### TC07 – Case/whitespace normalization

Steps:

1. Send To `  ALICE@Example.COM  `.
2. Verify matches LEAD-001 (lower+trim).
   Expected: Normalized.

### TC08 – Plus-address handling

Steps:

1. Send To `alice+promo@example.com`.
2. Document whether matches base alice (pass if yes per spec, else pending – record actual).
   Expected: Consistent with spec.

### TC09 – Multiple To matching same lead – single activity

Steps:

1. Send To alice + Cc alice second alias same lead.
2. Verify only 1 activity, `linkedContactIds` includes both or single per model.
   Expected: No dupes.

### TC10 – Multiple leads – one activity multi-linked

Steps:

1. Send To alice (LEAD-001) + bob (LEAD-002) same email.
2. Verify 1 email doc, 1 activity with `leadIds=[001,002]` OR 2 activities per spec – assert actual and record.
3. Check both timelines show it.
   Expected: Defined multi-link behavior.

### TC11 – BCC dedup – owner BCC’d no extra

Steps:

1. Send To alice, Bcc `bcc-crm@test.com` + rep1 self.
2. Verify exactly 1 activity.
3. Check inbound BCC copy webhook with same Message-ID does not create second.
   Expected: Dedup by Message-ID.

### TC12 – Same Message-ID re-delivered – idempotent

Steps:

1. POST inbound same payload twice (same Message-ID).
2. Second returns `deduped:true`, count unchanged.
   Expected: Idempotent.

### TC13 – Different Message-ID same content – two activities

Steps:

1. Send same subject/body twice (different IDs).
2. Verify 2 activities (not deduped on content).
   Expected: ID-based, not content.

### TC14 – BCC tracking address alone (no To match) – pending?

Steps:

1. Send To unknown, Bcc tracking only.
2. Verify pending (BCC alone does not auto-link).
   Expected: No false match.

### TC15 – Reply threading via In-Reply-To

Steps:

1. Send original, note Message-ID M1.
2. Send reply with `In-Reply-To: M1` + same subject.
3. Verify same `threadId`, timeline nested.
   Expected: Thread preserved.

### TC16 – Attachments logged

Steps:

1. Send with 2 attachments (pdf, png).
2. Verify activity shows paperclip + download links, email doc has `attachments[]`.
   Expected: Attachments surfaced.

### TC17 – Send failure – bad SMTP – queued retry

Steps:

1. Stop Mailhog / set bad SMTP host.
2. Send – expect 202 `queued`, `status=retrying`.
3. Restart SMTP, verify eventual `sent`.
   Expected: Retry queue.

### TC18 – Blocked domain / suppression

Steps:

1. Send to `bounce@test.com` on suppression list.
2. Assert 422 `suppressed` + no send + logged attempt.
   Expected: Suppression respected.

### TC19 – Large recipients (20 To) performance

Steps:

1. Send to 20 contacts (mix recognized/unrecognized).
2. Verify 1 send, activities per matched leads, pending per unmatched, completes <5s.
   Expected: Scales.

### TC20 – Permissions – rep cannot see other’s pending?

Steps:

1. rep1 pending for LEAD-001; login rep2 – verify cannot link rep1’s pending (403) unless admin.
   Expected: RBAC.

### TC21 – Delete email keeps activity?

Steps:

1. DELETE email doc, verify activity retained with `emailDeleted=true` OR both removed per spec – record.
   Expected: Defined retention.

### TC22 – Search emails by address/subject

Steps:

1. GET `/api/emails?q=alice` + `?messageId=` + UI search.
2. Verify finds sent + inbound.
   Expected: Search works.

## 5. API Testing Section

| Method | Endpoint                            | Purpose                 | Auth   |
| ------ | ----------------------------------- | ----------------------- | ------ |
| POST   | /api/emails/send                    | Outbound send + autolog | Bearer |
| POST   | /api/emails/inbound                 | Inbound webhook         | Secret |
| GET    | /api/emails                         | List emails             | Bearer |
| GET    | /api/emails/pending                 | Unrecognized queue      | Bearer |
| POST   | /api/emails/pending/:id/link        | Link to lead/deal       | Bearer |
| POST   | /api/emails/pending/:id/create-lead | Quick create            | Bearer |
| GET    | /api/activities?leadId=&type=email  | Verify autolog          | Bearer |

Example 1 – Send recognized:

```bash
curl -X POST http://localhost:3001/api/emails/send \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"to":["alice@example.com"],"subject":"Hi Acme","body":"Hello Alice","leadId":"LEAD-001"}'
```

Example 2 – Send unrecognized + check pending:

```bash
curl -X POST http://localhost:3001/api/emails/send \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"to":["unknown99@test.com"],"subject":"Hello?","body":"Hi"}'
curl http://localhost:3001/api/emails/pending -H "Authorization: Bearer $TOKEN"
```

Example 3 – Inbound webhook:

```bash
curl -X POST http://localhost:3001/api/emails/inbound \
 -H "Content-Type: application/json" -H "X-Webhook-Secret: $INBOUND_SECRET" \
 -d '{"from":"alice@example.com","to":["rep1@test.com"],"subject":"Re: Hi","body":"Thanks!","messageId":"msg-001@test"}'
# duplicate – expect deduped
curl -X POST http://localhost:3001/api/emails/inbound \
 -H "Content-Type: application/json" -H "X-Webhook-Secret: $INBOUND_SECRET" \
 -d '{"from":"alice@example.com","to":["rep1@test.com"],"subject":"Re: Hi","body":"Thanks!","messageId":"msg-001@test"}'
```

Example 4 – BCC dedup send:

```bash
curl -X POST http://localhost:3001/api/emails/send \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"to":["alice@example.com"],"bcc":["bcc-crm@test.com","rep1@test.com"],"subject":"BCC test","body":"Hi","messageId":"msg-bcc-01@test"}'
```

Example 5 – Link pending:

```bash
curl -X POST http://localhost:3001/api/emails/pending/PENDING_ID/link \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"leadId":"LEAD-001"}'
curl -X POST http://localhost:3001/api/emails/pending/PENDING2/create-lead \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"name":"NewBiz","email":"newbiz@test.com"}'
```

Example 6 – Multi-recipient + reply:

```bash
curl -X POST http://localhost:3001/api/emails/send \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"to":["alice@example.com","bob@example.com"],"subject":"Group update","body":"Hi both"}'
curl -X POST http://localhost:3001/api/emails/send \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"to":["alice@example.com"],"subject":"Re: Hi Acme","body":"Follow-up","inReplyTo":"msg-001@test"}'
```

## 6. UI Testing Section

- Compose at `http://localhost:3000/inbox/compose`: To autocomplete shows CRM contacts with lead badge; unknown address shows yellow `Unrecognized – will queue` hint.
- Sent view: `Logged to LEAD-001` chip; unrecognized shows `Pending – Link` button opening lead picker.
- Pending queue page: table From/Subject/Reason + `Link` / `Create lead` actions, bulk link.
- Timeline: inbound vs outbound icons, BCC badge `via BCC`, thread nesting.
- Mobile: compose full-screen, pending actions swipe.

## 7. Regression & Cross-Feature Impact

- Activities: every autolog appears in unified log; reply threading shared (see activities.md).
- Email-templates: sending with templateId renders variables before match logic – template failure must not send unrendered `{{var}}`.
- Email-tracking: opens/clicks attach to same email/activity Message-ID; BCC copy must not double-count opens.
- Sequences: sequence sends use same send pipeline + dedup; reply auto-pause depends on inbound match (see sequences.md).
- SLA: inbound from lead may satisfy first-response; outbound starts clock.

## 8. Expected Results Summary Table

| TC   | Action                | Activity?          | Pending? | Count        |
| ---- | --------------------- | ------------------ | -------- | ------------ |
| TC01 | To alice              | Yes 1              | No       | 1            |
| TC02 | To unknown            | No                 | Yes 1    | 0+1          |
| TC05 | Inbound alice         | Yes inbound        | No       | 1            |
| TC09 | Multi-alias same lead | 1                  | No       | 1            |
| TC11 | BCC self+tracking     | 1                  | No       | 1            |
| TC12 | Same ID x2            | 1 (second deduped) | No       | 1            |
| TC13 | Same content new ID   | 2                  | No       | 2            |
| TC15 | Reply                 | Same thread        | No       | +1 in thread |

## 9. Troubleshooting & Common Failures

- No activity after send: `EMAIL_AUTOLOG=false` or recipient typo (extra space) – check normalized match logs `autolog: no match for ...`.
- Duplicate activities: Message-ID not set client-side – server generates new each retry; ensure client reuses ID on retry, and BCC copy filtered.
- Pending not showing: filtered by owner – login as sender or admin; check `?status=all`.
- Inbound 401: wrong `X-Webhook-Secret`; rotate secret in env + provider.
- Plus-address mismatch: spec may treat `+` as distinct – adjust test expectation; check `NORMALIZE_PLUS` flag.
- Attachments missing: multipart size limit (default 10MB) – check `413`; use link for large files.
- Suppression confusion: test address on bounce list from prior run – clear via `DELETE /api/suppressions/:email` (admin).

## 10. Pass/Fail Checklist

- [ ] Recognized outbound logs (TC01)
- [ ] Unrecognized queues + banner (TC02)
- [ ] Link pending works (TC03)
- [ ] Create lead from pending (TC04)
- [ ] Inbound recognized/unrecognized (TC05-TC06)
- [ ] Normalization case/space (TC07)
- [ ] Plus-address documented (TC08)
- [ ] Same-lead multi-recipient single (TC09)
- [ ] Multi-lead behavior recorded (TC10)
- [ ] BCC dedup (TC11) + Message-ID idempotent (TC12)
- [ ] Content-duplicate creates two (TC13)
- [ ] BCC-alone pending (TC14)
- [ ] Reply threading (TC15)
- [ ] Attachments (TC16)
- [ ] Retry on SMTP fail (TC17)
- [ ] Suppression blocked (TC18)
- [ ] Bulk 20 recipients <5s (TC19)
- [ ] RBAC pending (TC20)
- [ ] Retention + search (TC21-TC22)
- [ ] All curl examples 2xx/deduped as noted
- [ ] UI compose + pending queue verified
