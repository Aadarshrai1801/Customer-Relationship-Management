# Email Tracking – Comprehensive Testing Guide

## 1. Overview

This guide covers Open and Click tracking events for outbound emails. Opens via 1x1 pixel (`GET /t/open/:trackingId.gif`), clicks via redirect (`GET /t/click/:trackingId?u=<url>`). Each send generates per-recipient `trackingId`s; events append to `email.events[]` and update `openCount/clickCount/firstOpenedAt/lastClickedAt`. Includes Apple Mail Privacy Protection (MPP) caveat: Apple pre-fetches pixels, causing false opens – UI must label `Apple MPP – open may be automated` and not use opens alone for SLA/sequence decisions where MPP detected.
Business rules:

- Tracking enabled per send (`tracking:{open:true,click:true}`); disabled sends have no pixel/links rewritten.
- One pixel fire = one event but deduped per `trackingId+ip+ua+minute`? Document actual; dashboard shows unique vs total.
- Click URL rewritten to tracking redirect preserving original `u`; direct original URL bypasses tracking (expected).
- MPP detection via User-Agent + headless prefetch pattern; flagged `mppSuspected=true`.
  Base URLs:
- API: `http://localhost:3001`
- Web: `http://localhost:3000`
- Tracking: `http://localhost:3001/t/open/:id.gif`, `http://localhost:3001/t/click/:id`

## 2. Prerequisites & Test Data Setup

- SMTP stubbed; tracking tables clean.
- Contacts alice, bob; send via `POST /api/emails/send` with tracking on.
- Need real `trackingId` per recipient: capture from `GET /api/emails/:id` (`recipients[].trackingId`).
- Tools: curl for pixel/redirect, browser devtools to inspect `<img src>` and `<a href>` rewriting.
- Apple MPP simulation: UA `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Mail/16.0` + prefetch header.
- Block images test: Gmail with images-off to verify no open until enabled.
- Users rep1 (sender), admin (analytics).

## 3. Test Environment Matrix

| Env                                                                                                   | Tracking Host                                | Notes                                |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------ |
| Local                                                                                                 | http://localhost:3001/t/*                    | Pixel returns 1x1 GIF 200, click 302 |
| CI                                                                                                    | Mock                                         | Assert event counts synchronously    |
| Staging                                                                                               | https://staging-api.example.com/t/*          | HTTPS pixel, redirect preserves UTM  |
| Clients                                                                                               | Gmail web, Outlook, Apple Mail 16+, iOS Mail | MPP vs real opens                    |
| Browsers                                                                                              | Chrome/Firefox/Safari                        | Link rewrite inspection              |
| Privacy                                                                                               | VPN, ad-block, images-off                    | No-open cases                        |
| Note: ad-block may block pixel – test with/without. Apple MPP test requires iCloud+ relay simulation. |

## 4. Detailed Step-by-Step Test Cases

### TC01 – Send with tracking injects pixel + rewrites links

Steps:

1. Send email with body `<a href="https://example.com/offer">Offer</a>` tracking on.
2. Fetch raw MIME via `GET /api/emails/:id/raw`.
3. Verify `<img src=".../t/open/xxx.gif">` present + link rewritten to `/t/click/xxx?u=...`.
   Expected: Injected.

### TC02 – Send tracking disabled – no pixel/links

Steps:

1. Send with `tracking:{open:false,click:false}`.
2. Verify raw has no pixel, original link intact.
   Expected: Clean.

### TC03 – Open pixel fires event

Steps:

1. Take trackingId for alice.
2. `GET /t/open/:id.gif` with browser UA.
3. GET email – `openCount>=1`, `firstOpenedAt` set, event `{type:open, ua, ip, at}`.
   Expected: Open logged.

### TC04 – Open dedup – rapid double fire

Steps:

1. Fire pixel twice within 10s same UA/IP.
2. Check whether counts as 1 unique + 2 total OR 2 – record per spec.
3. Dashboard shows Unique vs Total correctly.
   Expected: Defined dedup.

### TC05 – Click redirect preserves destination + logs

Steps:

1. `GET /t/click/:id?u=https://example.com/offer` (URL-encoded).
2. Verify 302 Location equals original, event `{type:click, url}`.
3. Follow redirect, verify landing.
   Expected: Click logged + redirect.

### TC06 – Click without open – valid sequence

Steps:

1. New email, fire click without prior open (images-off client).
2. Verify click counted, open still 0 – UI shows `Clicked without open (images blocked)` hint.
   Expected: Independent events.

### TC07 – Multiple recipients isolated trackingIds

Steps:

1. Send to alice+bob, capture both IDs.
2. Fire alice open only.
3. Verify alice openCount 1, bob 0; aggregate email openCount 1.
   Expected: Per-recipient.

### TC08 – Tampered trackingId 404, no crash

Steps:

1. GET `/t/open/invalid123.gif` – expect 404 transparent pixel or 404 JSON per spec (document).
2. GET click invalid – 404 page, no event.
   Expected: Graceful.

### TC09 – Expired trackingId after TTL?

Steps:

1. If `TRACKING_TTL` set (e.g., 90d), craft old ID or mock expired.
2. Verify expired returns gone but old events retained.
   Expected: TTL handling.

### TC10 – Apple MPP simulated prefetch flagged

Steps:

1. Fire pixel with Apple Mail UA + `X-Apple-Mail-Privacy` style headers (or documented MPP signature).
2. Verify event `mppSuspected=true`, email shows `Apple MPP – verify with clicks` badge.
3. Check analytics excludes MPP opens from `uniqueRealOpens` if spec.
   Expected: Flagged.

### TC11 – Apple MPP – click still trusted

Steps:

1. After MPP open, fire click with real browser UA.
2. Verify click trusted (`mppSuspected=false` for click), sequence/reply logic uses click not MPP open.
   Expected: Click authoritative.

### TC12 – Link UTM preserved through redirect

Steps:

1. Send link `https://example.com/?utm_source=crm&utm_campaign=test`.
2. Click via tracking, verify final URL retains params.
   Expected: No UTM strip.

### TC13 – Multiple links – per-URL click counts

Steps:

1. Email with 3 distinct links.
2. Click link A twice, link B once.
3. Verify `clicksByUrl={A:2,B:1,C:0}`.
   Expected: Granular.

### TC14 – Plain-text part tracking?

Steps:

1. Send multipart; check text part has no pixel (expected) but links may be rewritten or not per spec – record.
   Expected: Documented.

### TC15 – Forwarded email – second opener?

Steps:

1. Fire same trackingId from different IP/UA (simulate forward).
2. Verify second unique opener counted or flagged `forwardSuspected` per spec.
   Expected: Forward handling.

### TC16 – Ad-block / images-off – no false open

Steps:

1. Open email in client with images blocked, no pixel fetch.
2. Verify openCount 0 until `Load images` clicked.
   Expected: No phantom.

### TC17 – Analytics dashboard aggregates

Steps:

1. Send 5 emails, generate known opens/clicks (3 opens, 2 clicks).
2. Open `http://localhost:3000/emails/analytics` – verify rates `openRate=60%, clickRate=40%, CTR`.
3. Check per-template breakdown.
   Expected: Math correct.

### TC18 – Realtime event stream / webhook?

Steps:

1. If `TRACKING_WEBHOOK` configured, fire open and verify webhook POST received.
2. Check `GET /api/emails/:id/events` live without refresh (poll/WS).
   Expected: Realtime.

### TC19 – Unsubscribe link click – special handling

Steps:

1. Include `{{unsubscribeLink}}`, click via tracking.
2. Verify both click event + `unsubscribed=true`, future sends blocked (see suppression).
   Expected: Dual effect.

### TC20 – Performance – 100 rapid pixels

Steps:

1. Fire 100 pixel GETs concurrent (script).
2. Verify all logged, no 500, p95 <300ms, counts exact.
   Expected: Scales.

### TC21 – Privacy – IP anonymization if enabled

Steps:

1. With `PRIVACY_MASK_IP=true`, fire open, verify stored IP masked `1.2.3.xxx`.
2. UI does not expose full IP to non-admin.
   Expected: Privacy.

### TC22 – Disable tracking mid-campaign – old pixels?

Steps:

1. Disable tracking globally, fire old pixel – verify still logs (pixel already sent) OR 410 per spec – record.
   Expected: Defined.

## 5. API Testing Section

| Method | Endpoint                | Purpose                             | Auth   |
| ------ | ----------------------- | ----------------------------------- | ------ |
| POST   | /api/emails/send        | Send with tracking flags            | Bearer |
| GET    | /api/emails/:id         | Get counts + recipients trackingIds | Bearer |
| GET    | /api/emails/:id/raw     | Inspect pixel/link injection        | Bearer |
| GET    | /api/emails/:id/events  | List open/click events              | Bearer |
| GET    | /t/open/:trackingId.gif | Fire open                           | Public |
| GET    | /t/click/:trackingId?u= | Fire click + redirect               | Public |
| GET    | /api/emails/analytics   | Aggregate rates                     | Bearer |

Example 1 – Send tracked:

```bash
curl -X POST http://localhost:3001/api/emails/send \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"to":["alice@example.com"],"subject":"Offer","body":"<a href=\"https://example.com/offer\">Offer</a>","tracking":{"open":true,"click":true}}'
curl http://localhost:3001/api/emails/EMAIL_ID -H "Authorization: Bearer $TOKEN"
curl http://localhost:3001/api/emails/EMAIL_ID/raw -H "Authorization: Bearer $TOKEN"
```

Example 2 – Fire open:

```bash
curl -v "http://localhost:3001/t/open/TRACKING_ID.gif" -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126"
curl http://localhost:3001/api/emails/EMAIL_ID/events -H "Authorization: Bearer $TOKEN"
```

Example 3 – Fire click:

```bash
curl -v "http://localhost:3001/t/click/TRACKING_ID?u=https%3A%2F%2Fexample.com%2Foffer" -H "User-Agent: Mozilla/5.0 Chrome/126"
```

Example 4 – Apple MPP simulation:

```bash
curl -v "http://localhost:3001/t/open/TRACKING_ID.gif" \
 -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Mail/16.0" \
 -H "X-Mail-Privacy: 1"
curl http://localhost:3001/api/emails/EMAIL_ID/events -H "Authorization: Bearer $TOKEN"
```

Example 5 – Multi-link + analytics:

```bash
curl "http://localhost:3001/api/emails/EMAIL_ID/events?type=click" -H "Authorization: Bearer $TOKEN"
curl "http://localhost:3001/api/emails/analytics?from=2026-09-01&to=2026-09-08" -H "Authorization: Bearer $TOKEN"
```

Example 6 – Disabled tracking:

```bash
curl -X POST http://localhost:3001/api/emails/send \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"to":["bob@example.com"],"subject":"No track","body":"Hi","tracking":{"open":false,"click":false}}'
```

## 6. UI Testing Section

- `http://localhost:3000/emails/:id`: header `Opened 3x by 2 people`, timeline dots for opens/clicks with UA icons, MPP amber badge `Apple Privacy – may be auto-open`.
- List view: eye/cursor icons per row, hover tooltip `First opened 2h ago`.
- Analytics: cards Open rate / Click rate / CTR, per-link table, CSV export.
- Raw toggle: `View source` shows pixel + rewritten links.
- Mobile: event timeline collapses; MPP badge wraps.

## 7. Regression & Cross-Feature Impact

- Email-templates: tracked links inside rendered template must rewrite after variable substitution, not before.
- Sequences: open tracking must NOT auto-pause sequence if MPP suspected – only clicks/replies pause (see sequences.md).
- Emails: BCC copy opens must not inflate primary recipient count – per-trackingId isolation.
- SLA: opens never satisfy SLA; only replies/calls do.
- Privacy/GDPR: unsubscribe + IP masking interact; disabling tracking must still allow unsubscribe link.

## 8. Expected Results Summary Table

| TC   | Fire                 | Expected Count  | Flag              |
| ---- | -------------------- | --------------- | ----------------- |
| TC03 | 1 open               | open 1          | mpp false         |
| TC05 | 1 click              | click 1 + 302   | url preserved     |
| TC06 | Click w/o open       | click 1, open 0 | hint shown        |
| TC10 | MPP UA               | open 1          | mppSuspected true |
| TC11 | Real click after MPP | click trusted   | use click         |
| TC13 | A2+B1                | A2 B1 C0        | per-URL           |
| TC17 | 5 sends              | 60%/40%         | math              |
| TC19 | Unsub click          | click + unsub   | suppressed        |

## 9. Troubleshooting & Common Failures

- No open logged: images blocked, ad-block, or `tracking.open=false`; check raw for pixel; curl pixel directly to isolate.
- Click 404: `u` not URL-encoded – `&` splits query; always encode; check server decodes once.
- Double counts: prefetch (Gmail image proxy fetches twice) – dedup window should collapse; check `ip=google-proxy` grouping.
- MPP false negative: UA changed in iOS 17 – update detection regex; check `mppSuspected` logic in code.
- Pixel cached 304: browser caches GIF – pixel must send `Cache-Control: no-store`; hard reload or curl with `Cache-Control: no-cache`.
- Analytics 0%: date filter TZ excludes events – query UTC range; check `from/to` inclusive.
- Redirect loses UTM: double-encoding – encode once; verify Location header exactly.

## 10. Pass/Fail Checklist

- [ ] Pixel + link injection (TC01) and disabled clean (TC02)
- [ ] Open fires event (TC03) + dedup defined (TC04)
- [ ] Click 302 + logged (TC05), click-without-open hint (TC06)
- [ ] Per-recipient isolation (TC07)
- [ ] Invalid ID 404 graceful (TC08)
- [ ] TTL handling (TC09)
- [ ] MPP flagged (TC10), click trusted (TC11)
- [ ] UTM preserved (TC12), per-URL counts (TC13)
- [ ] Text-part documented (TC14)
- [ ] Forward handling (TC15)
- [ ] Images-off no phantom (TC16)
- [ ] Dashboard math (TC17)
- [ ] Realtime/webhook (TC18)
- [ ] Unsubscribe dual (TC19)
- [ ] 100 concurrent <300ms p95 (TC20)
- [ ] IP masking (TC21), disable-mid (TC22)
- [ ] All curl examples executed
- [ ] UI badges + analytics verified
- [ ] Apple MPP caveat documented in release notes
