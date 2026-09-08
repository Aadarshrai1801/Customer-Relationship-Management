# Scheduling & Booking – Comprehensive Testing Guide

## 1. Overview

This guide covers Booking Links (personal scheduling links with availability windows, duration, buffers, slot intervals) and the Public Booking Page (unauthenticated page where external guests pick a slot and confirm). Flow: rep creates booking link -> shares URL `/book/:slug` -> guest selects slot -> booking creates calendar event + meeting activity + notifications to both sides -> reschedule/cancel via tokenized links.
Business rules:

- Slots generated from `workingHours + dateRange + duration + buffer + existingEvents` (busy blocks excluded).
- Past slots never bookable; double-booking prevented via atomic slot claim.
- Public page requires no login; uses `slug` + optional `eventTypeId`; guest provides name/email.
- Each booking has `manageToken` for guest reschedule/cancel without login.
- Timezone: slots stored UTC, displayed in guest local timezone with selector.
  Base URLs:
- API: `http://localhost:3001`
- Web: `http://localhost:3000`
- Public: `http://localhost:3000/book/:slug`

## 2. Prerequisites & Test Data Setup

- Users: rep1 with calendar connected (Google sandbox) for busy-block testing.
- Working hours: rep1 Mon-Fri 09:00-17:00 UTC, 30-min duration, 10-min buffer, 30-min interval.
- Existing busy: create calendar event Tue 10:00-11:00 UTC to test exclusion.
- Booking link seed: `slug=rep1-intro`, title `Intro Call`, duration 30, buffer 10, range next 14 days.
- Guest data: `guest1@test.com`, `guest2@test.com` with distinct names.
- SMTP stubbed for guest confirmation + owner notification; check Mailhog.
- Clean: delete test bookings via `DELETE /api/bookings?test=true` or admin panel.
- Verify public page reachable without auth (incognito).
- Prepare expired slug and disabled link for negative tests.

## 3. Test Environment Matrix

| Env                                                                                      | URL                                    | Purpose                           |
| ---------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------- |
| Local Dev API                                                                            | http://localhost:3001                  | Link CRUD + slot + booking APIs   |
| Local Web                                                                                | http://localhost:3000                  | Owner link management UI          |
| Local Public                                                                             | http://localhost:3000/book/rep1-intro  | Guest flow incognito              |
| CI                                                                                       | Mock calendar busy                     | Deterministic slot assertions     |
| Staging                                                                                  | https://staging.example.com/book/*     | Real email delivery + SEO noindex |
| Browsers                                                                                 | Chrome, Safari, Firefox + mobile 390px | Slot grid responsive              |
| Timezones                                                                                | Guest IST, EST, UTC selector           | Slot conversion                   |
| Note: buffer + back-to-back booking tested with 30/10 combo; DST week tested separately. |

## 4. Detailed Step-by-Step Test Cases

### TC01 – Create booking link

Steps:

1. POST `/api/booking-links` as rep1: slug, title, duration 30, workingHours, buffer 10.
2. Assert 201, `url=/book/rep1-intro`.
3. GET `/api/booking-links/:id` verify fields.
   Expected: Link created.

### TC02 – Duplicate slug rejected

Steps:

1. POST same slug as different user or same.
2. Assert 409 `slug already taken`.
   Expected: Slug globally unique.

### TC03 – Invalid duration/buffer rejected

Steps:

1. POST duration 7 (not multiple of 5) or buffer > duration.
2. Assert 400.
   Expected: Validation.

### TC04 – List owner links

Steps:

1. GET `/api/booking-links?owner=rep1`.
2. Verify list includes rep1-intro with `isActive=true`, booking counts.
   Expected: Owner dashboard.

### TC05 – Get public link unauthenticated

Steps:

1. GET `/api/booking-links/public/rep1-intro` without token.
2. Verify returns title, duration, workingHours, no owner email leak (masked).
   Expected: Public safe payload.

### TC06 – Generate slots excludes busy + past + buffer

Steps:

1. GET `/api/booking-links/rep1-intro/slots?date=2026-09-09&tz=UTC`.
2. Verify 10:00 and 10:30 missing due to 10-11 busy + buffer (10:30 would overlap buffer).
3. Verify past times excluded if date=today.
   Expected: Correct slot math.

### TC07 – Slots respect working hours + weekends

Steps:

1. Query Saturday – expect `[]` + `reason=outside_working_hours`.
2. Query 08:00 weekday – excluded.
3. Query 16:30 with 30-min duration ending 17:00 – included; 17:00 excluded.
   Expected: Boundary correct.

### TC08 – Guest books valid slot

Steps:

1. POST `/api/bookings` with slug, slotStart UTC, guest name/email.
2. Assert 201 + `manageToken` + `eventId`.
3. Verify calendar event created + owner notified.
   Expected: Booking succeeds.

### TC09 – Double-booking same slot blocked

Steps:

1. Book slot S for guest1 (TC08).
2. Immediately POST same slot for guest2.
3. Assert 409 `slot already taken`.
   Expected: Atomic claim.

### TC10 – Booking past slot rejected

Steps:

1. POST slotStart 1 hour ago.
2. Assert 400 `cannot book in past`.
   Expected: Blocked.

### TC11 – Guest validation – bad email/missing name

Steps:

1. POST without name -> 400.
2. POST bad email `not-an-email` -> 400.
   Expected: Validation.

### TC12 – Booking creates calendar event + activity

Steps:

1. After TC08, GET `/api/calendar/events?bookingId=xxx` – event exists with attendee guest.
2. GET `/api/activities?bookingId=xxx` – meeting activity auto-logged.
   Expected: Side effects.

### TC13 – Owner + guest email notifications

Steps:

1. Check Mailhog: owner inbox has `New booking: Intro Call`, guest has `Confirmed`.
2. Verify manage links contain `?token=` in guest email.
   Expected: Both notified.

### TC14 – Guest reschedule via manageToken

Steps:

1. POST `/api/bookings/:id/reschedule` with token + newSlot.
2. Verify old event moved, activity updated, both notified `Rescheduled`.
3. Old slot becomes free (query slots shows it).
   Expected: Reschedule works.

### TC15 – Guest cancel via manageToken

Steps:

1. POST `/api/bookings/:id/cancel` with token + reason.
2. Verify status cancelled, calendar event cancelled-not-deleted, slot freed.
   Expected: Cancel works.

### TC16 – Invalid manageToken rejected

Steps:

1. Reschedule with wrong token -> 403.
2. Expired booking cancel after event time per policy -> 422 or allowed per spec (document).
   Expected: Token auth enforced.

### TC17 – Disable link stops bookings

Steps:

1. PATCH link `isActive=false`.
2. Public page shows `This link is disabled`.
3. POST booking -> 410 `link disabled`.
   Expected: Kill switch.

### TC18 – Buffer prevents back-to-back overlap

Steps:

1. With 10-min buffer, book 10:00-10:30.
2. Query slots – 09:30 (ends 10:00, buffer overlaps) excluded, 10:40 earliest next if interval allows or 11:00.
3. Verify math matches spec.
   Expected: Buffer enforced.

### TC19 – Timezone selector converts correctly

Steps:

1. Open public page, switch tz IST (+5:30).
2. Verify 09:00 UTC shows 14:30 IST.
3. Book via IST display, verify stored UTC correct.
   Expected: TZ conversion lossless.

### TC20 – Public page UX – mobile + no-login

Steps:

1. Open `/book/rep1-intro` incognito mobile.
2. Pick date -> slots -> form -> confirm screen with Add-to-calendar.
3. Verify no login redirect, no owner PII.
   Expected: Frictionless.

### TC21 – Owner edits link (duration change regenerates slots)

Steps:

1. PATCH duration 30->60.
2. Query slots – count halves, old bookings unaffected (grandfathered).
   Expected: Edit safe.

### TC22 – No-show / complete lifecycle

Steps:

1. PATCH booking `status=completed` post-meeting (owner).
2. Verify activity marked completed, guest gets thank-you per template if enabled.
   Expected: Lifecycle closed.

## 5. API Testing Section

| Method | Endpoint                                 | Purpose                | Auth        |
| ------ | ---------------------------------------- | ---------------------- | ----------- |
| POST   | /api/booking-links                       | Create link            | Bearer      |
| GET    | /api/booking-links                       | List owner links       | Bearer      |
| PATCH  | /api/booking-links/:id                   | Edit/disable           | Owner       |
| GET    | /api/booking-links/public/:slug          | Public metadata        | Public      |
| GET    | /api/booking-links/:slug/slots?date=&tz= | Slot generation        | Public      |
| POST   | /api/bookings                            | Guest book             | Public      |
| POST   | /api/bookings/:id/reschedule             | Guest reschedule       | manageToken |
| POST   | /api/bookings/:id/cancel                 | Guest cancel           | manageToken |
| GET    | /api/bookings/:id?token=                 | Manage view            | manageToken |
| PATCH  | /api/bookings/:id                        | Owner complete/no-show | Bearer      |

Example 1 – Create link:

```bash
curl -X POST http://localhost:3001/api/booking-links \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"slug":"rep1-intro","title":"Intro Call","durationMin":30,"bufferMin":10,"workingHours":{"mon_fri":"09:00-17:00"},"timezone":"UTC","isActive":true}'
```

Example 2 – Public metadata + slots:

```bash
curl http://localhost:3001/api/booking-links/public/rep1-intro
curl "http://localhost:3001/api/booking-links/rep1-intro/slots?date=2026-09-09&tz=UTC"
curl "http://localhost:3001/api/booking-links/rep1-intro/slots?date=2026-09-09&tz=Asia/Kolkata"
```

Example 3 – Guest book:

```bash
curl -X POST http://localhost:3001/api/bookings \
 -H "Content-Type: application/json" \
 -d '{"slug":"rep1-intro","slotStart":"2026-09-09T11:00:00Z","guestName":"Guest One","guestEmail":"guest1@test.com","timezone":"UTC","notes":"Interested in demo"}'
```

Example 4 – Double-book (expect 409):

```bash
curl -X POST http://localhost:3001/api/bookings \
 -H "Content-Type: application/json" \
 -d '{"slug":"rep1-intro","slotStart":"2026-09-09T11:00:00Z","guestName":"Guest Two","guestEmail":"guest2@test.com"}'
```

Example 5 – Reschedule / cancel with token:

```bash
curl -X POST http://localhost:3001/api/bookings/BOOK_ID/reschedule \
 -H "Content-Type: application/json" \
 -d '{"manageToken":"TOKEN","newSlotStart":"2026-09-09T14:00:00Z"}'
curl -X POST http://localhost:3001/api/bookings/BOOK_ID/cancel \
 -H "Content-Type: application/json" \
 -d '{"manageToken":"TOKEN","reason":"conflict"}'
```

Example 6 – Disable link:

```bash
curl -X PATCH http://localhost:3001/api/booking-links/LINK_ID \
 -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
 -d '{"isActive":false}'
```

## 6. UI Testing Section

- Owner: `http://localhost:3000/scheduling` – link cards with copy-URL, toggle active, stats (views/bookings), edit drawer with working-hours grid.
- Public: `http://localhost:3000/book/rep1-intro` – header avatar/title, timezone dropdown, date strip (14 days), slot pills, guest form, confirm screen with `Add to Google/Outlook` + `Reschedule/Cancel` links.
- Disabled: grey banner; expired date shows empty + contact owner.
- Mobile: date horizontal scroll, slots 2-col grid, sticky Confirm.
- Accessibility: slot buttons keyboard-focusable, aria-selected, form labels.

## 7. Regression & Cross-Feature Impact

- Calendar-sync: bookings push to provider; provider busy blocks slots – loop guard (booking event must not re-trigger slot invalidation race).
- Activities: booking creates meeting activity; reschedule updates it; cancel marks cancelled.
- Email-tracking: confirmation emails tracked for opens (see email-tracking.md) – ensure manageToken not leaked in tracking pixel URL.
- Notifications: owner push + email; guest email only (no account).
- SLA: booking creation may start first-response clock if linked to lead.

## 8. Expected Results Summary Table

| TC   | Action      | Expected      | Side Effect                 |
| ---- | ----------- | ------------- | --------------------------- |
| TC01 | Create link | 201 url       | Dashboard card              |
| TC06 | Slots       | Busy excluded | Correct count               |
| TC08 | Book        | 201 + token   | Event + activity + 2 emails |
| TC09 | Double-book | 409           | No second event             |
| TC14 | Reschedule  | 200 moved     | Old slot free               |
| TC15 | Cancel      | cancelled     | Slot free, event cancelled  |
| TC17 | Disable     | 410 on book   | Banner                      |
| TC19 | TZ IST      | +5:30 display | UTC stored                  |
| TC21 | Duration 60 | Slots halve   | Old bookings kept           |

## 9. Troubleshooting & Common Failures

- Slots empty unexpectedly: workingHours timezone vs query tz mismatch – always pass `tz`; check busy overlay (all-day blocks whole day if misconfigured).
- Double-booking allowed: missing atomic claim (unique index on link+slotStart) – check DB; race test with parallel curls.
- Public 404: slug case-sensitive; trailing slash handling; disabled vs not-found message differs.
- Guest email not received: SMTP stub down; check `http://localhost:8025`; owner notification in spam.
- ManageToken 403: token URL-encoded? `+`/`/` chars – use exact string; expiry per `MANAGE_TOKEN_TTL`.
- Timezone off by 30m: IST half-hour – ensure `luxon`/`date-fns-tz` used, not naive Date.
- Buffer ignored: buffer applied only after booking, not to external busy – verify spec; test both.

## 10. Pass/Fail Checklist

- [ ] Link create + duplicate slug blocked (TC01-TC02)
- [ ] Validation duration/buffer (TC03)
- [ ] Public metadata no leak (TC05)
- [ ] Slots exclude busy/past/buffer/weekends (TC06-TC07, TC18)
- [ ] Guest book succeeds (TC08), double-book 409 (TC09), past 400 (TC10)
- [ ] Guest validation (TC11)
- [ ] Event + activity created (TC12)
- [ ] Both emails with manageToken (TC13)
- [ ] Reschedule frees old slot (TC14)
- [ ] Cancel frees slot (TC15) + token enforced (TC16)
- [ ] Disable kills bookings (TC17)
- [ ] Timezone conversion (TC19)
- [ ] Mobile public UX (TC20)
- [ ] Duration edit halves slots, preserves old (TC21)
- [ ] Complete lifecycle (TC22)
- [ ] All curl examples executed
- [ ] Regression with calendar/activities checked
