# Calendar Sync – Comprehensive Testing Guide

## 1. Overview

This guide covers 2-way sync with Google Calendar and Outlook (Microsoft Graph). Key invariants: idempotent sync via composite key `provider + externalId`, cancelled events are marked cancelled-not-deleted (soft `status=cancelled`, retained for audit), and conflicts resolve with most-recent-wins (compare `updatedAt` / provider `updated` timestamp).
Scope: OAuth connect/disconnect, initial full sync, incremental sync (syncToken/deltaLink), create/update/cancel in both directions, conflict handling, recurring events, timezone handling, and sync logs.
Business rules:

- Unique index on `(provider, externalId)`; re-sync same event updates, never duplicates.
- Deletion from provider => local `status=cancelled`, `cancelledAt` set, not hard deleted.
- Local cancel => provider cancel (not delete) where API supports.
- Conflict: if both sides changed since last sync, larger `updatedAt` wins; loser kept in history.
- Initial sync pulls 90 days past + 365 days future by default.
  Base URLs:
- API: `http://localhost:3001`
- Web: `http://localhost:3000`

## 2. Prerequisites & Test Data Setup

- API + Web running; env vars `GOOGLE_CLIENT_ID/SECRET`, `OUTLOOK_CLIENT_ID/SECRET` set to test OAuth apps.
- Test accounts: `crm.test.google@gmail.com`, `crm.test.outlook@outlook.com` with 5 pre-seeded events each.
- Local user rep1 connects both providers; verify `GET /api/calendar/connections` shows `google:connected, outlook:connected`.
- Use sandbox calendar `CRM Test` to avoid polluting primary.
- Time control: create events with explicit UTC times; note provider `updated` precision (Google ms, Outlook s).
- Seed local events: `EVT-LOCAL-1` (meeting tomorrow 10am UTC), `EVT-LOCAL-2` recurring weekly.
- Enable sync logs: `GET /api/calendar/sync-logs` should be queryable.
- Have `PROVIDER_EVENT_ID` samples: Google `_8coj...`, Outlook `AQMk...`.
- Disconnect/reconnect must be tested – ensure re-connect reuses same `providerAccountId`.

## 3. Test Environment Matrix

| Env                                                                                                                                         | Provider                                          | Auth                                 | Sync Mode                        |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------ | -------------------------------- |
| Local Dev                                                                                                                                   | Google sandbox + Outlook sandbox                  | OAuth test apps (localhost redirect) | Manual trigger + polling 2min    |
| CI                                                                                                                                          | Mock provider server (stub)                       | Fake tokens                          | Deterministic conflict injection |
| Staging                                                                                                                                     | Real Google/Outlook test tenants                  | Staging OAuth                        | Webhook push + scheduled pull    |
| Browsers                                                                                                                                    | Chrome/Edge                                       | -                                    | Connect buttons, status badges   |
| Timezones                                                                                                                                   | UTC, America/Los_Angeles, Asia/Kolkata            | -                                    | All-day + DST checks             |
| Network                                                                                                                                     | Online, offline simulate, 429 rate-limit simulate | -                                    | Retry/backoff                    |
| Note: mock server allows forcing `updated` timestamps for most-recent-wins without waiting. Rate-limit test uses stub 429 with Retry-After. |

## 4. Detailed Step-by-Step Test Cases

### TC01 – Connect Google account

Steps:

1. Click `Settings > Calendar > Connect Google`, complete OAuth.
2. Verify redirect to `/settings?calendar=connected`, connection row green.
3. GET `/api/calendar/connections` shows provider google, email, syncToken stored.
   Expected: Connected.

### TC02 – Connect Outlook account

Steps:

1. Same flow for Outlook (Microsoft login).
2. Verify both connections listed simultaneously.
   Expected: Multi-provider per user.

### TC03 – Initial full sync pulls provider events

Steps:

1. Ensure Google test calendar has 5 events.
2. POST `/api/calendar/sync/run?provider=google`.
3. GET `/api/calendar/events` – count +5, each has `provider=google`, `externalId` set.
   Expected: No duplicates, all fields mapped (title, start, end, attendees).

### TC04 – Idempotent re-sync – no duplicates

Steps:

1. Run sync twice without changes.
2. Verify count unchanged, `sync-log` second run `created=0, updated=0, skipped=5`.
3. Check DB unique index no violation.
   Expected: Idempotent via provider+externalId.

### TC05 – Local create pushes to provider

Steps:

1. POST local event `title SyncPushTest`, start tomorrow.
2. Verify sync run pushes, local doc gains `externalId`, provider calendar shows event.
3. Check `syncDirection=local->remote` in log.
   Expected: 2-way create.

### TC06 – Provider create pulls locally

Steps:

1. Create event directly in Google UI `ProviderPushTest`.
2. Run incremental sync.
3. Verify local copy appears with same externalId.
   Expected: remote->local.

### TC07 – Local update propagates

Steps:

1. Update local EVT title + time.
2. Run sync, verify Google event updated (check via provider API or UI).
3. Verify `updatedAt` bumped both sides eventually consistent.
   Expected: Update sync.

### TC08 – Provider update pulls

Steps:

1. Update Google event time +2h.
2. Run sync, verify local start shifted.
   Expected: Pull update.

### TC09 – Provider delete => local cancelled-not-deleted

Steps:

1. Delete event in Google (or move to trash).
2. Run sync.
3. GET local: `status=cancelled`, still present, `cancelledAt` set, not 404.
4. UI shows greyed strikethrough + `Cancelled (on Google)` badge.
   Expected: Soft cancel.

### TC10 – Local cancel pushes cancel (not delete)

Steps:

1. PATCH local `/api/calendar/events/:id` `status=cancelled`.
2. Run sync, verify provider event cancelled (Google status cancelled, Outlook isCancelled true) still retrievable.
3. Verify local still present.
   Expected: Cancel propagation.

### TC11 – Hard delete never happens via sync

Steps:

1. Query deleted event id – expect 200 with cancelled, not 404.
2. Only explicit `DELETE ?hard=true` as admin removes row.
   Expected: Audit retention.

### TC12 – Conflict most-recent-wins – local newer wins

Steps:

1. Record base event synced, note `lastSyncedAt`.
2. Update provider event at T+1min (set updated T1), update local at T+2min (T2>T1).
3. Run sync – verify final title/time equals local version on both sides.
4. Check log `conflictResolved=winner:local`.
   Expected: Local wins.

### TC13 – Conflict most-recent-wins – remote newer wins

Steps:

1. Reverse: local T1, provider T2 newer.
2. Run sync – verify local overwritten with provider values.
3. Check history retains losing version.
   Expected: Remote wins.

### TC14 – Conflict tie – same second deterministic

Steps:

1. Force both updated to same second (mock).
2. Verify deterministic tie-break: `provider` wins or `local` per spec – document actual.
3. Ensure no flip-flop on next sync (stable).
   Expected: Stable tie-break.

### TC15 – Recurring event sync

Steps:

1. Create Google recurring weekly 5x.
2. Sync, verify local master + 5 instances with `recurrenceId`/`seriesMasterExternalId`.
3. Cancel single instance on provider, sync, verify only that instance cancelled locally.
   Expected: Recurrence fidelity.

### TC16 – All-day + timezone handling

Steps:

1. Create all-day event in IST provider calendar.
2. Verify local `isAllDay=true`, `startDate` not shifted to previous day in UTC view.
3. Check UI renders correct date in EST and IST.
   Expected: No off-by-one.

### TC17 – Incremental sync uses syncToken/deltaLink

Steps:

1. Note syncToken after full sync.
2. Make one change, run incremental.
3. Verify log `mode=incremental`, only 1 updated, token rotated.
   Expected: Efficient delta.

### TC18 – SyncToken expired – full resync fallback

Steps:

1. Invalidate token (mock 410 Gone).
2. Run sync – expect fallback to full sync with warning, no data loss, no dupes.
   Expected: Graceful recovery.

### TC19 – Disconnect stops sync, retains data

Steps:

1. Disconnect Google.
2. Create provider event, run sync – verify not pulled, log `skipped: disconnected`.
3. Local events remain queryable.
   Expected: Clean disconnect.

### TC20 – Reconnect resumes without duplicates

Steps:

1. Reconnect same account.
2. Run sync – verify counts match, no dupes, cancelled states preserved.
   Expected: Idempotent reconnect.

### TC21 – Rate-limit + retry backoff

Steps:

1. Mock provider 429 with Retry-After 5s.
2. Run sync, verify job retries with backoff, eventually succeeds, log shows `retried`.
   Expected: Resilient.

### TC22 – Multi-provider isolation (same title different provider)

Steps:

1. Create same-title events on Google and Outlook.
2. Sync both, verify two local docs with different `(provider, externalId)`.
3. Update Google only – Outlook copy untouched.
   Expected: No cross-provider merge.

## 5. API Testing Section

| Method | Endpoint                               | Purpose                     | Auth         |
| ------ | -------------------------------------- | --------------------------- | ------------ |
| GET    | /api/calendar/connections              | List linked accounts        | Bearer       |
| POST   | /api/calendar/connect?provider=google  | Initiate OAuth              | Bearer       |
| POST   | /api/calendar/disconnect               | Disconnect                  | Bearer       |
| POST   | /api/calendar/sync/run?provider=google | Trigger sync                | Bearer       |
| GET    | /api/calendar/events                   | List local synced events    | Bearer       |
| POST   | /api/calendar/events                   | Create local (push on sync) | Bearer       |
| PATCH  | /api/calendar/events/:id               | Update/cancel local         | Bearer       |
| GET    | /api/calendar/sync-logs                | Inspect runs                | Bearer/Admin |
| GET    | /api/calendar/events/:id/history       | Conflict history            | Bearer       |

Example 1 – Connections + trigger sync:

```bash
curl http://localhost:3001/api/calendar/connections -H "Authorization: Bearer $TOKEN"
curl -X POST "http://localhost:3001/api/calendar/sync/run?provider=google" -H "Authorization: Bearer $TOKEN"
```

Example 2 – Create local event:

```bash
curl -X POST http://localhost:3001/api/calendar/events \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"title":"SyncPushTest","startAt":"2026-09-10T10:00:00Z","endAt":"2026-09-10T11:00:00Z","timezone":"UTC","attendees":["alice@example.com"]}'
```

Example 3 – Cancel local (soft):

```bash
curl -X PATCH http://localhost:3001/api/calendar/events/EVT_ID \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"status":"cancelled","cancelReason":"client requested"}'
```

Example 4 – List + history for conflict check:

```bash
curl "http://localhost:3001/api/calendar/events?provider=google&status=all" -H "Authorization: Bearer $TOKEN"
curl http://localhost:3001/api/calendar/events/EVT_ID/history -H "Authorization: Bearer $TOKEN"
curl http://localhost:3001/api/calendar/sync-logs?limit=5 -H "Authorization: Bearer $TOKEN"
```

Example 5 – Simulate conflict (mock server):

```bash
# provider-side newer update via mock
curl -X POST http://localhost:3001/api/test/mock-provider/google/events/EXT_ID/touch \
 -H "Content-Type: application/json" -d '{"title":"Provider newer","updatedAt":"2026-09-08T12:02:00Z"}'
# local newer update
curl -X PATCH http://localhost:3001/api/calendar/events/EVT_ID \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"title":"Local newer"}'
curl -X POST "http://localhost:3001/api/calendar/sync/run?provider=google" -H "Authorization: Bearer $TOKEN"
```

Example 6 – Disconnect/reconnect:

```bash
curl -X POST http://localhost:3001/api/calendar/disconnect \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"provider":"google"}'
```

## 6. UI Testing Section

- `http://localhost:3000/settings/calendar`: Connect buttons, connected email + Last synced `2m ago`, Sync Now spinner, Disconnect confirm modal.
- `http://localhost:3000/calendar`: synced events show provider icon (G/O), cancelled greyed strikethrough, conflict badge `Updated from Google just now`.
- Event drawer: shows `External ID`, `Provider updated`, `Local updated`, history timeline of conflict resolutions.
- Toast on sync: `Synced 5 events (3 updated, 2 new)`.
- Offline banner: `Sync paused – reconnecting…` when provider 429/offline.

## 7. Regression & Cross-Feature Impact

- Scheduling-booking: bookings create calendar events – must sync outward without loop.
- Activities: synced meetings auto-appear as meeting activities; cancelled shows cancelled activity, not deleted.
- Tasks: task due dates overlay calendar – must not be pushed to provider as events.
- Notifications: conflict resolution notifies owner once, not on every sync poll.
- SLA: meeting reschedule via sync updates SLA timelines if linked to deal.

## 8. Expected Results Summary Table

| TC   | Action          | Expected Local        | Expected Provider | Log                  |
| ---- | --------------- | --------------------- | ----------------- | -------------------- |
| TC03 | Initial pull    | 5 created             | -                 | created=5            |
| TC04 | Re-sync         | 0 change              | -                 | skipped=5            |
| TC05 | Local create    | externalId filled     | Event appears     | local->remote        |
| TC09 | Provider delete | status=cancelled      | Gone/trash        | remote->local cancel |
| TC10 | Local cancel    | cancelled             | Cancelled         | local->remote cancel |
| TC12 | Local newer     | Local wins both       | Updated to local  | winner:local         |
| TC13 | Remote newer    | Overwritten           | Keeps newer       | winner:remote        |
| TC15 | Recur 5x        | Master+5              | Same              | expanded             |
| TC18 | Token 410       | Full resync, no dupes | -                 | fallback:full        |
| TC20 | Reconnect       | No dupes              | -                 | resumed              |

## 9. Troubleshooting & Common Failures

- `401 invalid_grant`: OAuth refresh token revoked – reconnect; check server `REFRESH_TOKEN` rotation.
- Duplicates after sync: missing unique index on (provider, externalId) – check DB indexes; ensure externalId mapping for recurring instances uses `externalId_instanceDate`.
- Cancelled still active on provider: used DELETE instead of cancel – use `events.patch(status=cancelled)` for Google, `cancel` endpoint for Graph.
- Conflict flapping: clock skew – compare provider `updated` (server time) not local wall clock; log both timestamps.
- All-day off by one: provider sends `date` not `dateTime` – ensure `isAllDay` branch ignores timezone conversion.
- Sync 410 loop: token rotation not persisted – verify `syncToken` saved after each run.
- Outlook deltaLink null: initial sync not completed – run full sync first.

## 10. Pass/Fail Checklist

- [ ] Google + Outlook connect (TC01-TC02)
- [ ] Initial pull creates with externalId (TC03)
- [ ] Re-sync idempotent, no dupes (TC04)
- [ ] Local create pushes (TC05) and provider create pulls (TC06)
- [ ] Updates propagate both directions (TC07-TC08)
- [ ] Deletes become cancelled-not-deleted both directions (TC09-TC11)
- [ ] Local-newer conflict wins (TC12)
- [ ] Remote-newer conflict wins (TC13)
- [ ] Tie stable (TC14)
- [ ] Recurrence instances correct (TC15)
- [ ] All-day/timezone correct (TC16)
- [ ] Incremental token used (TC17) and 410 fallback (TC18)
- [ ] Disconnect retains, reconnect no dupes (TC19-TC20)
- [ ] 429 retry succeeds (TC21)
- [ ] Multi-provider isolation (TC22)
- [ ] All curl examples executed
- [ ] UI badges + history verified
- [ ] Regression with booking/activities checked
