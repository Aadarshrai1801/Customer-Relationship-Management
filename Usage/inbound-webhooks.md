# Inbound Webhooks – Comprehensive Testing Guide

Base URLs: API `http://localhost:3001`, Web `http://localhost:3000`.

## 1. Overview

This guide covers Generic HMAC Inbound Webhooks plus API triggers: receiving external events, verifying signatures, mapping payloads to CRM actions, and logging deliveries.
Scope includes webhook endpoint creation, secret generation/rotation, signature verification (HMAC-SHA256), timestamp tolerance/replay protection, payload mapping/templates, triggering workflows/automation, idempotency/dedupe, delivery log with retries, and enable/disable/delete.
Out of scope is outbound webhooks (see `workflows-automation.md`), but end-to-end inbound→workflow is tested.
Key roles: Admin (manage endpoints/secrets), Manager/Rep (view runs for accessible records), anonymous caller (must sign correctly – no JWT, only HMAC).
Critical rules: unsigned/wrong-signature requests rejected 401; stale timestamps rejected; same `eventId` deduplicated; secrets never returned in full after creation (masked) except rotation; every delivery logged with status.
Success criteria: valid signed calls create/update records and/or fire workflows exactly once; invalid calls rejected with clear codes; replay and tamper blocked.

## 2. Prerequisites & Test Data Setup

- Stack: Web `:3000`, API `:3001`, worker for async processing; clock synced (NTP) for timestamp checks.
- Admin token `$ADMIN_TOKEN`; test endpoint slug e.g., `qa-inbound-20260908`.
- Tools: `curl`, `python3` for HMAC calc, webhook sender script; record secret securely (env var `$WH_SECRET`, never commit).
- Test payloads:
  - `contact.created` minimal `{eventId, type, data:{email, firstName, lastName}}`.
  - `deal.updated` `{eventId, type, data:{dealId, amount, stage}}`.
  - Large payload (1MB) and malformed JSON for negatives.
- Baseline: counts of contacts/deals before; delivery log empty for new endpoint.
- Time: note server `Date` header vs local; configure tolerance (e.g., ±5 min – confirm spec).
- Cleanup: delete QA endpoint + created records; rotate secret if exposed in logs (mask in evidence).

## 3. Test Environment Matrix

| Dimension      | Variants                                                                |
| -------------- | ----------------------------------------------------------------------- |
| Caller         | curl, Postman, external service simulator, workflow trigger             |
| Auth           | Valid HMAC, Wrong secret, Missing sig, Stale timestamp, Replay          |
| Payload        | Valid, Missing fields, Extra fields, Wrong types, Malformed JSON, Large |
| Endpoint state | Enabled, Disabled, Deleted, Rotated secret                              |
| Processing     | Sync immediate, Queued async, Bulk 50 rapid                             |
| Record scope   | Create contact, Update deal, Fire workflow, Unknown mapping             |
| Network        | Broadband, Timeout client, Retry with same eventId                      |

- Record: endpoint ID/URL, `eventId`s, signature headers, timestamps, HTTP statuses, run IDs.
- Test both JSON and `application/x-www-form-urlencoded` if supported (document).
- Verify tenant isolation: signature for org A must not write to org B.

## 4. Detailed Step-by-Step Test Cases (at least 18 numbered TC cases)

### TC-01 – Create Inbound Endpoint (UI + API)

- **Objective:** Verify endpoint creation returns URL + secret once.
- **Preconditions:** Logged in as admin.
- **Steps:**
  1. Go to Settings/Workflows → Inbound Webhooks → New; name `QA-Inbound`.
  2. Select mappings (e.g., `contact.created → Create Contact`).
  3. Save; verify URL `http://localhost:3001/api/webhooks/in/:idOrSlug` + secret shown once with Copy.
  4. Reload; verify secret masked (`sk_…••••`).
  5. `GET /api/webhooks/in` lists endpoint as Enabled.
- **Expected:** URL + one-time secret; masked thereafter.

### TC-02 – Valid Signed Delivery Creates Contact

- **Objective:** Verify happy-path HMAC creates record.
- **Preconditions:** Endpoint enabled; secret known.
- **Steps:**
  1. Build payload with fresh `eventId=qa-001`, `timestamp=now`.
  2. Compute `HMAC_SHA256(secret, rawBody + '.' + timestamp)` per spec (confirm exact scheme from docs/implementation – record it).
  3. POST with headers `X-Signature`, `X-Timestamp`, `X-Event-Id`.
  4. Expect 200/202 with `{deliveryId, status:accepted}`.
  5. Verify contact created with mapped fields.
- **Expected:** 2xx + record created <10s (or queued then created – document).

### TC-03 – Signature Scheme Exactness

- **Objective:** Pin down canonical signing string.
- **Preconditions:** Valid secret.
- **Steps:**
  1. Try variants if docs unclear: rawBody only vs `timestamp.rawBody` vs hex vs base64.
  2. Record which succeeds; document for team.
  3. Verify response error for wrong scheme is 401 `invalid_signature` (not 500).
- **Expected:** One documented scheme; others 401.

### TC-04 – Missing / Wrong Signature Rejected

- **Objective:** Verify auth enforcement.
- **Preconditions:** Valid payload.
- **Steps:**
  1. POST without signature → expect 401.
  2. POST with wrong secret HMAC → 401.
  3. POST with tampered body (change one char after signing) → 401.
  4. Verify no record created and delivery logged as Rejected (if logged).
- **Expected:** 401 trio; no side effects.

### TC-05 – Stale Timestamp Rejected (Replay Window)

- **Objective:** Verify ±5min tolerance.
- **Preconditions:** Valid signature logic.
- **Steps:**
  1. Sign with timestamp 10 min ago → expect 401/400 `stale_timestamp`.
  2. Sign with future +10 min → expect reject.
  3. Sign with now-2min → expect accept.
- **Expected:** Window enforced; skewed blocked.

### TC-06 – Replay Same eventId Deduplicated

- **Objective:** Verify idempotency.
- **Preconditions:** Delivered `eventId=qa-001` already.
- **Steps:**
  1. Re-POST identical body+headers (same eventId).
  2. Expect 200 with `{deduped:true}` or 409 per spec – document.
  3. Verify no duplicate contact (count unchanged).
  4. Verify delivery log shows second as Duplicate.
- **Expected:** Exactly-once effect.

### TC-07 – Disabled Endpoint Rejects

- **Objective:** Verify disable stops ingestion.
- **Preconditions:** Endpoint enabled, then disable.
- **Steps:**
  1. Disable endpoint.
  2. POST valid signed → expect 404/410/403 `endpoint_disabled`.
  3. Re-enable; POST new eventId → expect success.
- **Expected:** Disabled blocks; re-enable resumes.

### TC-08 – Secret Rotation

- **Objective:** Verify rotation invalidates old, new works, no downtime surprise.
- **Preconditions:** Endpoint with traffic.
- **Steps:**
  1. Rotate secret; verify new secret shown once.
  2. POST with old secret → 401.
  3. POST with new secret → success.
  4. Verify old deliveries still logged.
- **Expected:** Atomic rotation; old immediately invalid (or grace window documented).

### TC-09 – Payload Mapping: Deal Update

- **Objective:** Verify field mapping updates correct record.
- **Preconditions:** Existing `DEAL-MAP` + mapping `deal.updated → Update Deal by externalId/id`.
- **Steps:**
  1. POST `deal.updated` with `amount: 22000, stage: Proposal`.
  2. Verify deal updated; timeline notes `via inbound webhook`.
  3. POST with unknown `dealId` → expect 404 delivery Failed with `record_not_found`.
- **Expected:** Mapped update correct; unknown handled.

### TC-10 – Validation: Missing/ Wrong Types

- **Objective:** Verify 400 with field errors, no partial writes.
- **Preconditions:** Endpoint enabled.
- **Steps:**
  1. POST `contact.created` without `email` → 400 `email required`.
  2. POST with `amount:"not-a-number"` → 400.
  3. Verify no half-created records.
- **Expected:** Structured 400; atomic.

### TC-11 – Malformed JSON & Content-Type

- **Objective:** Verify parser errors graceful.
- **Preconditions:** Valid sig computed over raw malformed bytes (document approach).
- **Steps:**
  1. POST `not-json{{{` with `Content-Type: application/json` → 400 `invalid_json`.
  2. POST valid JSON as `text/plain` → 415 or 400 per spec.
  3. POST empty body → 400.
- **Expected:** No 500; clear codes.

### TC-12 – Large Payload Limit

- **Objective:** Verify size cap.
- **Preconditions:** 1MB and 10MB payloads.
- **Steps:**
  1. POST 1MB valid-shaped → expect success or documented cap.
  2. POST 10MB → expect 413.
  3. Verify worker memory stable.
- **Expected:** Cap enforced; documented limit (e.g., 1MB/5MB).

### TC-13 – Bulk 50 Rapid Deliveries

- **Objective:** Verify throughput + ordering/dedupe under burst.
- **Preconditions:** 50 unique eventIds.
- **Steps:**
  1. Loop POST 50 contacts rapidly.
  2. Verify all 2xx; 50 contacts created; 50 deliveries logged.
  3. Check p95 latency + queue depth.
- **Expected:** No drops; no 429 unless rate-limited (then document limit + Retry-After).

### TC-14 – Inbound → Workflow Trigger Chain

- **Objective:** Verify inbound event fires downstream workflow.
- **Preconditions:** Workflow trigger = Inbound Webhook `contact.created` or record-created.
- **Steps:**
  1. POST contact.created.
  2. Verify contact created AND workflow run logged (e.g., welcome task created).
  3. Verify delivery links to workflow runId.
- **Expected:** Chained; both logs cross-reference.

### TC-15 – Delivery Log & Retry

- **Objective:** Verify log completeness + manual retry/redeliver.
- **Preconditions:** Mix of success/failed deliveries.
- **Steps:**
  1. Open endpoint → Deliveries; verify columns time/eventId/type/status/latency + payload viewer + response.
  2. For failed (bad mapping), fix mapping then Retry; verify Success + no duplicate on already-succeeded (retry creates new deliveryId, idempotent via eventId).
  3. Verify pagination.
- **Expected:** Full audit; retry safe.

### TC-16 – Tenant Isolation

- **Objective:** Verify org A webhook cannot touch org B.
- **Preconditions:** Two orgs if multitenant available.
- **Steps:**
  1. Use org A secret+URL to create contact; verify appears only in A.
  2. Swap URL to org B with A signature → 401.
  3. Verify direct record IDs from B rejected in A payloads.
- **Expected:** Strict isolation. If single-tenant dev, record N/A with reasoning.

### TC-17 – Delete Endpoint

- **Objective:** Verify deletion stops + cleans safely.
- **Preconditions:** QA endpoint with deliveries.
- **Steps:**
  1. Delete (confirm modal).
  2. POST to old URL → 404.
  3. Verify deliveries retained read-only or purged per retention – document.
- **Expected:** 404; no ghost processing.

### TC-18 – Observability: Headers, Timing, Clock Skew Note

- **Objective:** Verify operators can debug.
- **Preconditions:** Recent deliveries.
- **Steps:**
  1. Verify response includes `X-Delivery-Id`, `X-Request-Id`.
  2. Verify log shows signature version, timestamp delta, processing ms.
  3. Document skew guidance (sync NTP, send `Date` header).
- **Expected:** Debuggable; docs updated.

### TC-19 – Negative: Method & Path Abuse

- **Objective:** Verify only POST allowed on delivery URL.
- **Preconditions:** Valid endpoint URL.
- **Steps:**
  1. `GET` URL → 404/405.
  2. `PUT/DELETE` → 405.
  3. POST to `/api/webhooks/in/does-not-exist` with garbage sig → 404 (not 401 leak – document order).
  4. SQLi in payload `'; DROP TABLE--` → stored escaped, no error.
- **Expected:** Correct codes; no info leak; injection inert.

## 5. API Testing Section

| Method & Endpoint                                 | Purpose                       | Auth           | Notes                       |
| ------------------------------------------------- | ----------------------------- | -------------- | --------------------------- |
| `POST /api/webhooks/in`                           | Create endpoint               | Bearer (admin) | Returns `url + secret` once |
| `GET /api/webhooks/in`                            | List endpoints                | Bearer         | Masked secrets              |
| `POST /api/webhooks/in/:slug`                     | Deliver event (HMAC, not JWT) | HMAC headers   | Core path                   |
| `GET /api/webhooks/in/:id/deliveries`             | Delivery log                  | Bearer         | Filter `status`             |
| `POST /api/webhooks/in/:id/rotate-secret`         | Rotate                        | Bearer (admin) | New secret once             |
| `POST /api/webhooks/in/:id/deliveries/:did/retry` | Redeliver                     | Bearer         | Idempotent                  |
| `DELETE /api/webhooks/in/:id`                     | Delete                        | Bearer (admin) | 404 after                   |

```bash
# 1) Create endpoint (admin JWT)
curl -s -X POST http://localhost:3001/api/webhooks/in \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"QA-Inbound","mappings":[{"event":"contact.created","action":"createContact"}]}' | python3 -m json.tool
# save .url as $WH_URL and .secret as $WH_SECRET (shown once!)

# 2) Send signed event (adjust signing scheme to implementation; example: HMAC(rawBody + timestamp))
TS=$(date +%s)
BODY='{"eventId":"qa-001","type":"contact.created","data":{"email":"wh-qa-001@test.com","firstName":"Wh","lastName":"Qa"}}'
SIG=$(python3 -c "import hmac,hashlib,os; s=os.environ['WH_SECRET']; b='''$BODY'''; t='$TS'; print(hmac.new(s.encode(), (b+'.'+t).encode(), hashlib.sha256).hexdigest())")
curl -i -X POST "$WH_URL" -H "Content-Type: application/json" \
  -H "X-Timestamp: $TS" -H "X-Signature: sha256=$SIG" -H "X-Event-Id: qa-001" \
  -d "$BODY"

# 3) Replay same eventId (expect deduped)
curl -i -X POST "$WH_URL" -H "Content-Type: application/json" \
  -H "X-Timestamp: $TS" -H "X-Signature: sha256=$SIG" -H "X-Event-Id: qa-001" \
  -d "$BODY" | head -n 20

# 4) Wrong secret should 401
curl -i -X POST "$WH_URL" -H "Content-Type: application/json" \
  -H "X-Timestamp: $TS" -H "X-Signature: sha256=deadbeef" -H "X-Event-Id: qa-002" \
  -d "$BODY" | head -n 20

# 5) Delivery log
curl -s http://localhost:3001/api/webhooks/in/ENDPOINT_ID/deliveries \
  -H "Authorization: Bearer $ADMIN_TOKEN" | python3 -m json.tool
```

- If actual header names differ (`X-Webhook-Signature`, `svix-*`, etc.), probe implementation, update this file, and re-run.
- Assert: valid → 200/202 + record; replay → deduped; bad sig/stale/disabled → 401/404 with `code` field.

## 6. UI Testing Section

- List: endpoints table (Name, URL with Copy, Events, Status toggle, Last delivery, Actions); secret masked; Copy URL button.
- Create/edit modal: name, event→action mapping pickers, field-mapping table, test-send button, save validation.
- Delivery drawer: request headers/body (pretty JSON), signature check badge (`Valid/Invalid`), response, linked record + workflow run links, Retry button.
- Toggles: enable/disable immediate with toast; delete asks typed confirm if destructive.
- Test-send: fills sample payload, signs locally, shows result inline.
- Responsive: tables scroll at 768px; payload viewer wraps; dark parity for JSON viewer.
- A11y: labels for secret (masked `aria-label`), copy buttons announce `Copied`, log has headings.

## 7. Regression & Cross-Feature Impact

- Workflows: inbound must fire eligible workflows; loop guard still applies (inbound storm must not bypass maxRuns).
- Contacts/Deals: created/updated via webhook appear in lists, search, reports after refresh.
- Notifications: record creation via webhook should notify assignees per rules (or explicitly not – document).
- Auth: JWT endpoints unaffected; HMAC scope limited to delivery URL only (cannot call other APIs with HMAC).
- Rate limiting: burst 50 must respect limiter with `429 + Retry-After`, not 500.
- Audit: deliveries attributed to `webhook:<endpoint>` actor; secret rotation audited.
- Billing: delivery volume quotas (if any) enforced.

## 8. Expected Results Summary Table

| TC    | Title            | Expected                      | Severity |
| ----- | ---------------- | ----------------------------- | -------- |
| TC-01 | Create endpoint  | URL+secret once, masked after | Critical |
| TC-02 | Valid delivery   | 2xx + record                  | Critical |
| TC-03 | Scheme pinned    | Documented                    | Major    |
| TC-04 | Bad sig          | 401, no side effect           | Critical |
| TC-05 | Stale time       | Rejected                      | Major    |
| TC-06 | Replay dedupe    | No duplicate                  | Critical |
| TC-07 | Disabled blocks  | 4xx                           | Major    |
| TC-08 | Rotation         | Old 401, new OK               | Major    |
| TC-09 | Deal mapping     | Correct update                | Major    |
| TC-10 | Validation 400   | No partial                    | Major    |
| TC-11 | Malformed        | 400, no 500                   | Minor    |
| TC-12 | Size cap         | 413 large                     | Minor    |
| TC-13 | Bulk 50          | All logged                    | Major    |
| TC-14 | →Workflow chain  | Linked runs                   | Major    |
| TC-15 | Log + retry      | Safe retry                    | Major    |
| TC-16 | Tenant isolation | Strict                        | Critical |
| TC-17 | Delete           | 404 after                     | Minor    |
| TC-18 | Observability    | IDs + timing                  | Minor    |
| TC-19 | Method abuse     | 404/405                       | Minor    |

## 9. Troubleshooting & Common Failures

| Symptom                | Cause                                                    | Fix                                                           |
| ---------------------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| 401 on valid sig       | Wrong canonical string (hex vs base64, prefix `sha256=`) | Log server-computed vs sent; align scheme; check secret trim  |
| 401 stale immediately  | Clock skew > tolerance                                   | Sync NTP; compare `Date` header; allow ±5min                  |
| 200 but no record      | Async queue lag or mapping to wrong action               | Check delivery status `queued→processed`; inspect worker logs |
| Duplicates on retry    | Missing eventId dedupe                                   | Always send stable `eventId`; check unique index              |
| 404 on valid URL       | Slug typo / trailing slash / deleted                     | Copy URL exactly; check list; verify enabled                  |
| 413 on small           | Proxy limit lower than app                               | Raise `client_max_body_size`; retest                          |
| Secret visible in logs | Logged headers                                           | Redact; rotate; mask evidence screenshots                     |
| Workflow not firing    | Trigger filter mismatch                                  | Check workflow trigger equals inbound event type              |

- Debug: `X-Delivery-Id` → delivery detail → worker log correlation; `python3` HMAC snippet archived with run.
- Safety: never paste live secrets into tickets; mask as `sk_…ab12`.

## 10. Pass/Fail Checklist

- [ ] Endpoint create shows secret once, masks after; list/toggle work.
- [ ] Valid HMAC creates/updates + 200/202; scheme documented.
- [ ] Bad/missing/tampered sig → 401 with no side effects.
- [ ] Stale timestamp rejected; replay deduped (no duplicate record).
- [ ] Disabled blocks; rotation swaps (old 401/new OK); delete → 404.
- [ ] Validation 400s atomic; malformed/size handled; bulk 50 all logged.
- [ ] Inbound→workflow chain linked; retry safe; tenant isolated.
- [ ] API curls pass; UI log shows payloads + signature badges.
- [ ] Evidence: signed request/response pairs, delivery log exports, record screenshots (secrets redacted).
- [ ] Cleanup: QA endpoint deleted, records removed, exposed secrets rotated.
