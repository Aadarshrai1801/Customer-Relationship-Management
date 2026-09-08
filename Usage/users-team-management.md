# Users & Team Management – Comprehensive Testing Guide

## 1. Overview (what feature does, where in UI/API, related files)

Nexus CRM Users covers CRUD users, invites, suspend/reactivate, role assignment, profile, search/filter, and team listing. Foundation for RBAC and audit.

**What it does:**

- Admin lists users with pagination/search/status filter via `GET /users`.
- Admin creates user directly or invites via `POST /users/invites {email,role}` (sends Mailpit invite).
- Admin updates name/role/status via `PATCH /users/:id`, suspends via `POST /users/:id/suspend`, reactivates via `POST /users/:id/reactivate`, deletes (soft/hard) via `DELETE /users/:id`.
- Users view own profile `GET /users/me`, update own name/avatar.
- Enforces unique email, valid role, cannot demote last admin, cannot suspend self.

**Where in UI:**

- Web `http://localhost:3000/settings/team` or `/admin/users` – table (name/email/role/status/last login), Search, Filters, Invite button, row actions Edit/Suspend/Delete.
- Web Invite modal – email + role dropdown + Send.
- Web `http://localhost:3000/accept-invite?token=` – invitee sets password.
- Web `http://localhost:3000/profile` – own edit.

**Where in API:**

- `GET /users`, `GET /users/:id`, `POST /users`, `PATCH /users/:id`, `DELETE /users/:id`
- `POST /users/invites`, `GET /users/invites`, `POST /users/invites/:id/resend`, `DELETE /users/invites/:id`
- `POST /users/:id/suspend`, `POST /users/:id/reactivate`
- `GET /users/me`, `PATCH /users/me`

**Related files:**

- `api/src/users/users.controller.ts`, `users.service.ts`, `invites.service.ts`, `users.entity.ts`
- `api/src/auth/auth.service.ts` (accept-invite), `api/src/mail/*`
- `web/src/app/settings/team/page.tsx`, `components/InviteModal.tsx`, `UserTable.tsx`
- PRD: Users, Invites, RBAC.

## 2. Prerequisites & Test Data Setup (infra:up, db:migrate, users/roles, .env keys)

**Infra:**

```bash
docker compose -f infra/docker-compose.yml up -d postgres redis mailpit
npm run db:migrate
npm run dev:api
npm run dev:web
```

**.env:**

- `WEB_URL=http://localhost:3000`, `SMTP_HOST=localhost SMTP_PORT=1025`
- `INVITE_TTL_DAYS=7`, `DEFAULT_ROLE=member`
- `ADMIN_EMAIL=admin@example.com`

**Users/roles:**

- Admin `admin@example.com / Password123!` (admin, active).
- Second admin `admin2@example.com / Password123!` (to test last-admin guard).
- Member `member@example.com / Password123!`.
- Test targets: `teammate@example.com`, `invitee2@example.com` (ensure deleted: `DELETE FROM users WHERE email LIKE 'teammate%'`).
- Mailpit empty.

**Seed:**

```sql
SELECT id,email,role,status FROM users ORDER BY created_at;
SELECT * FROM invites ORDER BY created_at DESC LIMIT 5;
```

## 3. Test Environment Matrix (roles x browsers, API via curl, mailpit, DB checks)

| Role            | Chrome                    | Firefox | API curl               | Mailpit      | DB                 |
| --------------- | ------------------------- | ------- | ---------------------- | ------------ | ------------------ |
| Admin full CRUD | Yes                       | Smoke   | Yes                    | Invite mails | users/invites rows |
| Manager limited | Yes – only invite member? | –       | Yes – 403 on admin ops | –            | –                  |
| Member read-own | Yes – no team page        | –       | 403 list, 200 me       | –            | –                  |
| Suspended       | Blocked login             | –       | 401/403                | –            | status             |
| Anonymous       | Redirect login            | –       | 401                    | –            | –                  |

**API:** admin cookies vs member cookies. **Mailpit:** `http://localhost:8025` search invitee. **DB:** status/role/invite token.

## 4. Detailed Step-by-Step Test Cases (numbered TC-01, TC-02... at least 20 cases covering: happy path, validation, edge cases, negative, permissions/RBAC, persistence/reload, concurrency, audit side-effects)

**TC-01 – List users happy path:**

- As admin `GET /users?page=1&limit=20` or UI team page.
- Expected: 200 `{data:[...], total}`, table shows admin/member, pagination works.

**TC-02 – Search/filter:**

- UI search `member@example.com`, filter status=active, role=admin.
- Expected: Filtered rows only; API `?search=member&role=admin&status=active` correct.

**TC-03 – Create user directly happy path:**

- `POST /users {name:Teammate, email:teammate@example.com, password:Password123!, role:member}`.
- Expected: 201, login as teammate works, appears in list.

**TC-04 – Invite happy path:**

- As admin UI Invite `invitee2@example.com` role member, Send.
- Expected: 201 invite, Mailpit mail with `/accept-invite?token=...`, status pending.

**TC-05 – Accept invite (covered auth but verify team side):**

- Complete accept with `Password123!`.
- Expected: User active, invite accepted, list count +1.

**TC-06 – Resend invite:**

- `POST /users/invites/:id/resend` for pending.
- Expected: 200 new token/expiry extended, second Mailpit mail. Accepted invite resend -> 410.

**TC-07 – Cancel/delete invite:**

- `DELETE /users/invites/:id` pending.
- Expected: 204, link now invalid (accept -> 404), no user created.

**TC-08 – Update user role happy path:**

- `PATCH /users/:id {role:manager}` for teammate.
- Expected: 200 role updated, new perms effective on next request (no relogin needed or documented).

**TC-09 – Suspend happy path:**

- `POST /users/:id/suspend` for teammate.
- Expected: 200 status suspended, login now 403, list badge Suspended, protected APIs 403.

**TC-10 – Reactivate:**

- `POST /users/:id/reactivate`.
- Expected: 200 active, login works again.

**TC-11 – Delete user:**

- `DELETE /users/:id` (check soft vs hard per PRD).
- Expected: 204/200, list gone, login 401, related deals reassigned or blocked per rule – document.

**TC-12 – Validation – invalid email/weak pw/invalid role:**

- `POST /users {email:bad, password:123, role:superuser}`.
- Expected: 400 each, UI inline, no row.

**TC-13 – Duplicate email:**

- Create with `member@example.com`.
- Expected: 409, UI banner.

**TC-14 – Cannot suspend self:**

- As admin suspend own id.
- Expected: 400 “Cannot suspend yourself”. Status unchanged.

**TC-15 – Cannot demote last admin:**

- With single admin, `PATCH /users/adminId {role:member}`.
- Expected: 400 “At least one admin required”. With two admins, demote one succeeds.

**TC-16 – RBAC – member cannot list/invite/suspend:**

- As member `GET /users`, `POST /users/invites`, `POST /users/:id/suspend`.
- Expected: 403 each. UI team page hidden/404.

**TC-17 – RBAC – manager limited (per PRD):**

- Verify manager can invite member but not admin, cannot suspend admin.
- Expected: 403 where forbidden, 201 where allowed – record matrix.

**TC-18 – Edge – invite existing email:**

- Invite `member@example.com` already active.
- Expected: 409 “User already exists”. No mail.

**TC-19 – Edge – expired invite:**

- Manipulate `expires_at` past or wait TTL, then accept.
- Expected: 410 expired UI, resend creates fresh.

**TC-20 – Persistence/reload – list pagination/suspend survives:**

- Suspend then reload team page, logout/login, check status still suspended; pagination page 2 reload keeps data.
- Expected: DB persisted, UI consistent.

**TC-21 – Concurrency – double invite same email:**

- Two parallel `POST /users/invites {email:race2@example.com}`.
- Expected: One 201 one 409, single pending row.

**TC-22 – Audit – CRUD logged:**

- After create/role change/suspend/reactivate/delete, `GET /audit-logs?entity=user`.
- Expected: Entries with actor admin, target id, old/new role/status.

**TC-23 – Profile self-update:**

- As member `PATCH /users/me {name:New Name}`.
- Expected: 200, UI profile updates, other users unaffected. Cannot self-escalate role via this endpoint (try `{role:admin}` -> ignored/403).

**TC-24 – Empty/loading/error:**

- Empty invite email submit, Slow 3G list load skeleton, API down team page error with Retry.
- Expected: Proper states, no crash.

**TC-25 – Avatar/upload edge if present:**

- Upload 10MB image vs 50B, wrong type .exe.
- Expected: Cap enforced (e.g., 5MB 400), preview works.

## 5. API Testing Section (endpoint table + at least 5 curl examples with expected status/body)

| Method | Path                         | Auth     | Success   | Errors              |
| ------ | ---------------------------- | -------- | --------- | ------------------- |
| GET    | /users?search=&role=&status= | admin    | 200 paged | 403 member          |
| POST   | /users                       | admin    | 201       | 400/409             |
| PATCH  | /users/:id                   | admin    | 200       | 400 last-admin, 404 |
| DELETE | /users/:id                   | admin    | 204       | 404                 |
| POST   | /users/invites               | admin    | 201       | 409 exists          |
| POST   | /users/:id/suspend           | admin    | 200       | 400 self            |
| POST   | /users/:id/reactivate        | admin    | 200       | 404                 |
| GET    | /users/me                    | any auth | 200       | 401                 |

**Curl 1 – List + Search:**

```bash
curl -i -b admin_cookies.txt "http://localhost:3001/users?page=1&limit=5&search=member"
# Expected: 200 {"data":[{"email":"member@example.com"}],"total":...}
curl -i -b member_cookies.txt http://localhost:3001/users
# Expected: 403
```

**Curl 2 – Create:**

```bash
curl -i -b admin_cookies.txt -X POST http://localhost:3001/users \
 -H "Content-Type: application/json" -d '{"name":"Teammate","email":"teammate@example.com","password":"Password123!","role":"member"}'
# Expected: 201 {"email":"teammate@example.com"}
```

**Curl 3 – Invite + Resend:**

```bash
curl -i -b admin_cookies.txt -X POST http://localhost:3001/users/invites \
 -H "Content-Type: application/json" -d '{"email":"invitee2@example.com","role":"member"}'
# Expected: 201 {"token":"..."} + Mailpit mail
curl -i -b admin_cookies.txt -X POST http://localhost:3001/users/invites/<ID>/resend
# Expected: 200 {"ok":true}
```

**Curl 4 – Suspend/Reactivate + Patch role:**

```bash
curl -i -b admin_cookies.txt -X POST http://localhost:3001/users/<ID>/suspend
# Expected: 200 {"status":"suspended"}
curl -i -b admin_cookies.txt -X PATCH http://localhost:3001/users/<ID> \
 -H "Content-Type: application/json" -d '{"role":"manager"}'
# Expected: 200 {"role":"manager"}
curl -i -b admin_cookies.txt -X POST http://localhost:3001/users/<ID>/reactivate
# Expected: 200 {"status":"active"}
```

**Curl 5 – Self guard:**

```bash
curl -i -b admin_cookies.txt -X POST http://localhost:3001/users/<ADMIN_ID>/suspend
# Expected: 400 {"message":"Cannot suspend yourself"}
curl -i -b member_cookies.txt -X PATCH http://localhost:3001/users/me \
 -H "Content-Type: application/json" -d '{"name":"New Name","role":"admin"}'
# Expected: 200 name changed but role ignored (verify GET still member)
```

## 6. UI Testing Section (navigation path, assertions, empty/loading/error states, responsive, dark mode, keyboard/a11y)

**Navigation:** `/settings/team` -> assert table columns, search filters live, Invite opens modal -> fill `teammate@example.com` + role -> Send -> toast + row pending. Row menu Suspend -> confirm modal -> badge updates. Edit role -> save -> toast.
**Assertions:** Pagination next/prev, total count, status badges colors, last-login relative, invite pending expiry date.
**Empty:** No results for `zzz-no-match` shows empty illustration + Clear button. No users edge (fresh org) shows Invite CTA.
**Loading:** Skeleton rows on Slow 3G, Invite button spinner, suspend confirm disabled while pending.
**Error:** API down -> error card + Retry; invite failure toast with reason.
**Responsive:** 375px table -> cards, actions in overflow menu, modal full-screen.
**Dark mode:** Badges readable, modal inputs contrast.
**Keyboard/a11y:** Table sortable via keyboard, modal focus trap, Esc closes, role select labelled, suspend confirm announces, Lighthouse >=90.

## 7. Regression & Cross-Feature Impact

- Auth: new/suspended/reactivated users login accordingly; deleted cannot login; invite accept tested.
- Roles: role change immediately affects perms (deals/reports visibility) – re-run roles suite.
- Audit: all mutations logged; verify no PII leak (password hash never returned).
- Org settings: attachment caps etc unaffected; user count vs plan limits if enforced.
- GDPR: deleted user data redacted/exported per privacy flow.
- 2FA/SSO: SSO JIT users appear here; ssoOnly users still manageable.

## 8. Expected Results Summary Table

| TC    | Desc            | Expected               |
| ----- | --------------- | ---------------------- |
| TC-01 | List            | 200 paged              |
| TC-02 | Search/filter   | correct subset         |
| TC-03 | Create          | 201 login works        |
| TC-04 | Invite          | 201 + mail             |
| TC-05 | Accept          | active +1              |
| TC-06 | Resend          | new mail, old extended |
| TC-07 | Cancel          | invalid link           |
| TC-08 | Role update     | effective              |
| TC-09 | Suspend         | 403 login              |
| TC-10 | Reactivate      | login ok               |
| TC-11 | Delete          | gone                   |
| TC-12 | Validation      | 400                    |
| TC-13 | Duplicate       | 409                    |
| TC-14 | Self-suspend    | 400 blocked            |
| TC-15 | Last admin      | 400 blocked            |
| TC-16 | Member 403      | forbidden              |
| TC-17 | Manager limits  | matrix                 |
| TC-18 | Invite existing | 409                    |
| TC-19 | Expired         | 410                    |
| TC-20 | Persist         | DB/UI consistent       |
| TC-21 | Race invite     | single row             |
| TC-22 | Audit           | logged                 |
| TC-23 | Self profile    | ok, no escalation      |
| TC-24 | Empty/loading   | proper                 |
| TC-25 | Avatar caps     | enforced               |

## 9. Troubleshooting & Common Failures

- **Invite mail missing:** SMTP/Mailpit down, wrong `invitee` spelling, spam search; check `docker logs mailpit`.
- **Accept 404:** Token trimmed, already accepted/cancelled/expired – resend fresh.
- **403 as admin:** Wrong cookies (member jar), role actually member – `SELECT role FROM users`.
- **Cannot suspend self confusion:** Use second admin to suspend first if need test.
- **Last-admin block unexpected:** Count admins `SELECT COUNT(*) WHERE role='admin' AND status='active'` – need 2 to demote one.
- **Role not effective:** Cached JWT/session – logout/login, clear, check guard reads fresh DB.
- **Pagination total wrong:** Soft-deleted counted – filter `deleted_at IS NULL`.
- **Duplicate race creates 2:** Missing unique index on email – add DB constraint.
- **UI team 404 for admin:** Route guard misconfig – check role string case `admin` vs `Admin`.

## 10. Pass/Fail Checklist (checkbox list)

- [ ] List/search/filter correct (TC-01/02)
- [ ] Create direct 201 (TC-03)
- [ ] Invite sends Mailpit (TC-04)
- [ ] Accept activates (TC-05)
- [ ] Resend works, accepted resend 410 (TC-06)
- [ ] Cancel invalidates (TC-07)
- [ ] Role update effective (TC-08)
- [ ] Suspend blocks login (TC-09)
- [ ] Reactivate restores (TC-10)
- [ ] Delete removes (TC-11)
- [ ] Validation 400 (TC-12)
- [ ] Duplicate 409 (TC-13)
- [ ] Self-suspend blocked (TC-14)
- [ ] Last-admin blocked (TC-15)
- [ ] Member 403s (TC-16)
- [ ] Manager limits verified (TC-17)
- [ ] Invite existing 409 (TC-18)
- [ ] Expired 410 (TC-19)
- [ ] Persistence ok (TC-20)
- [ ] Race single (TC-21)
- [ ] Audit logged (TC-22)
- [ ] Self profile no escalation (TC-23)
- [ ] Empty/loading/error ok (TC-24)
- [ ] Avatar caps (TC-25)
- [ ] Curls pass, responsive/dark/a11y pass
