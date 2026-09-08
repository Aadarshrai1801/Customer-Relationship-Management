# Auth Signup Login Sessions – Comprehensive Testing Guide

## 1. Overview (what feature does, where in UI/API, related files)

Nexus CRM Auth covers email signup, email login, logout, cookie-based sessions, password reset (forgot/reset), and invite acceptance. This is the entry point for all roles.

**What it does:**

- Allows new users to sign up with email + password + name + org context via `POST /auth/signup`.
- Allows existing users to log in via `POST /auth/login` and establishes an HttpOnly cookie session.
- Provides `POST /auth/logout` to destroy server session and clear cookie.
- Provides `GET /auth/me` to return current session user.
- Provides password reset flow: `POST /auth/forgot-password` (sends Mailpit email) -> `POST /auth/reset-password` with token.
- Provides invite acceptance via Web page `/accept-invite?token=xxx` calling `POST /auth/accept-invite`.
- Enforces password policy (min length from org security settings, default 8), email uniqueness, account status (active/suspended).

**Where in UI:**

- Web `http://localhost:3000/login` – Login form (email, password, SSO button, Forgot password link).
- Web `http://localhost:3000/signup` – Signup form (name, email, password, org name/slug optional).
- Web `http://localhost:3000/forgot-password` – Request reset link.
- Web `http://localhost:3000/reset-password?token=...` – Set new password.
- Web `http://localhost:3000/accept-invite?token=...` – Accept invite page (shows org name, role, set password).
- Web header avatar -> Logout button; Session list in `http://localhost:3000/settings/security` if implemented.

**Where in API:**

- Base API `http://localhost:3001`
- `POST /auth/signup`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`
- `POST /auth/forgot-password`, `POST /auth/reset-password`, `POST /auth/accept-invite`, `GET /auth/verify-reset-token?token=`
- `GET /auth/sessions`, `DELETE /auth/sessions/:id` (if implemented for multi-session)

**Related files (PRD / codebase):**

- `api/src/auth/auth.controller.ts` – all auth routes.
- `api/src/auth/auth.service.ts` – signup/login/password hashing (bcrypt), session creation.
- `api/src/auth/session.entity.ts` / `session.service.ts` – cookie sessions, TTL.
- `api/src/auth/guards/*` – AuthGuard, RolesGuard.
- `api/src/users/users.service.ts` – user creation on signup/invite.
- `api/src/mail/mail.service.ts` – reset/invite emails via Mailpit.
- `web/src/app/(auth)/login/page.tsx`, `signup/page.tsx`, `forgot-password/page.tsx`, `reset-password/page.tsx`, `accept-invite/page.tsx`.
- `web/src/lib/auth-client.ts` – fetch with credentials include.
- PRD sections: Auth, Sessions, Invites, Password Reset.

## 2. Prerequisites & Test Data Setup (infra:up, db:migrate, users/roles, .env keys)

**Infra:**

```bash
docker compose -f infra/docker-compose.yml up -d postgres redis mailpit
npm run db:migrate
npm run db:seed  # if available, else manual
npm run dev:api  # http://localhost:3001
npm run dev:web  # http://localhost:3000
```

Verify: `curl http://localhost:3001/health` -> 200, Mailpit `http://localhost:8025` reachable, Web login loads.

**.env keys required:**

- `DATABASE_URL=postgres://nexus:nexus@localhost:5432/nexus_crm`
- `REDIS_URL=redis://localhost:6379` (session store if used)
- `SESSION_SECRET=super-secret-test-key-32chars+`
- `SESSION_TTL_HOURS=24` (default), `COOKIE_SECURE=false` for localhost, `COOKIE_SAMESITE=lax`
- `SMTP_HOST=localhost`, `SMTP_PORT=1025`, `SMTP_FROM=no-reply@nexus.local`
- `WEB_URL=http://localhost:3000`, `API_URL=http://localhost:3001`
- `PASSWORD_MIN_LENGTH=8`

**Users / Roles to create:**

- Admin: `admin@example.com / Password123!` role=admin, org=Nexus Test Org.
- Member: `member@example.com / Password123!` role=member.
- Suspended: `suspended@example.com / Password123!` status=suspended.
- Fresh signup candidate: `test@example.com / Password123!` (ensure deleted before test: `DELETE FROM users WHERE email='test@example.com'`).
- Invite candidate: `invitee@example.com` (no account yet, invite via `POST /users/invites`).

**DB checks:**

```sql
SELECT id,email,status,role,org_id FROM users WHERE email IN ('test@example.com','admin@example.com');
SELECT id,user_id,expires_at,ip,ua FROM sessions WHERE user_id='...';
SELECT * FROM password_reset_tokens ORDER BY created_at DESC LIMIT 5;
```

**Cleanup between runs:**

- Delete test user, clear Mailpit messages (DELETE via Mailpit API), clear cookies in browser (Application -> Cookies -> Clear).

## 3. Test Environment Matrix (roles x browsers, API via curl, mailpit, DB checks)

| Role / State           | Chrome (latest)           | Firefox | Edge  | API curl        | Mailpit                 | DB check            |
| ---------------------- | ------------------------- | ------- | ----- | --------------- | ----------------------- | ------------------- |
| Anonymous (no session) | Yes – signup/login/forgot | Yes     | Yes   | Yes             | Verify no mail yet      | No session row      |
| New signup user        | Yes                       | Yes     | Smoke | Yes             | Welcome mail if enabled | users row created   |
| Member active          | Yes                       | Yes     | Yes   | Yes             | Reset mail              | session row         |
| Admin                  | Yes                       | Smoke   | Yes   | Yes             | Invite mail             | invite row          |
| Suspended              | Yes – login blocked       | Yes     | -     | Yes – 403       | No reset mail leak      | status=suspended    |
| Expired session        | Yes – redirect login      | Yes     | -     | 401 on /auth/me | -                       | expires_at < now()  |
| Invite pending         | Yes – accept-invite page  | Yes     | -     | Yes             | Invite mail in Mailpit  | invites token valid |

**API via curl:** Always use `-i -c cookies.txt -b cookies.txt` to persist cookies. Test with `curl http://localhost:3001/auth/me`.
**Mailpit:** Open `http://localhost:8025`, search to: `test@example.com` or `invitee@example.com`, verify subject, link contains `token=`.
**DB checks:** After login, assert session row exists; after logout, assert deleted/expired; after signup, assert password_hash != plaintext.
**Browsers:** Run full matrix on Chrome; smoke on Firefox/Edge for login/logout/persistence.
**Mobile/responsive:** Covered in Section 6.

## 4. Detailed Step-by-Step Test Cases (numbered TC-01, TC-02... at least 20 cases covering: happy path, validation, edge cases, negative, permissions/RBAC, persistence/reload, concurrency, audit side-effects)

**TC-01 – Happy path signup (new org user):**

- Pre: Ensure `test@example.com` not exists.
- Steps: Go to `http://localhost:3000/signup`. Enter Name=`Test User`, Email=`test@example.com`, Password=`Password123!`, Org=`TestOrg TC01`. Click Sign Up.
- Expected: Redirect to `/dashboard` or `/login?registered=1`. API 201. DB user created, status active. Cookie set if auto-login.

**TC-02 – Happy path login (existing user):**

- Steps: Go to `/login`. Enter `member@example.com / Password123!`. Click Login.
- Expected: Redirect to `/dashboard`. `GET /auth/me` returns 200 with email. Cookie `connect.sid` or `nexus_session` HttpOnly.

**TC-03 – Happy path logout:**

- Pre: Logged in as member.
- Steps: Click avatar -> Logout. Confirm.
- Expected: Redirect to `/login`. Cookie cleared. `GET /auth/me` -> 401. DB session deleted.

**TC-04 – Signup validation – invalid email:**

- Input: Email=`not-an-email`, Password=`Password123!`.
- Expected: UI inline error “Enter valid email”. API `POST /auth/signup` -> 400 `{message: email must be valid}`. No DB row.

**TC-05 – Signup validation – weak password:**

- Input: Email=`weak@example.com`, Password=`123`.
- Expected: UI “Password must be at least 8 chars, include upper/lower/number/symbol” if enforced. API 400. No user.

**TC-06 – Signup duplicate email:**

- Pre: `member@example.com` exists.
- Steps: Signup with same email, Password=`Password123!`.
- Expected: API 409 Conflict “Email already in use”. UI error banner. No duplicate DB row.

**TC-07 – Login wrong password (negative):**

- Input: `member@example.com / WrongPass999!`.
- Expected: UI “Invalid email or password”. API 401. No session created. Audit log `auth.login_failed` if implemented.

**TC-08 – Login non-existent email:**

- Input: `nosuch@example.com / Password123!`.
- Expected: Same generic 401 (no user enumeration). Ensure response time similar, message identical to TC-07.

**TC-09 – Login suspended user blocked:**

- Input: `suspended@example.com / Password123!`.
- Expected: API 403 “Account suspended”. UI “Contact admin”. No session. Verify audit.

**TC-10 – Password reset request happy path:**

- Steps: Go to `/forgot-password`, enter `member@example.com`, Submit.
- Expected: UI “If account exists, email sent”. API 200 always (anti-enumeration). Mailpit receives mail to member with reset link `http://localhost:3000/reset-password?token=...` within 30s.

**TC-11 – Password reset request for unknown email (anti-enumeration):**

- Input: `unknown999@example.com`.
- Expected: Same UI success message, API 200, but NO Mailpit mail to that address. DB no token.

**TC-12 – Password reset complete happy path:**

- Pre: Get token from Mailpit latest mail (copy token query param).
- Steps: Go to `/reset-password?token=<token>`, enter New=`NewPass123!`, Confirm=`NewPass123!`, Submit.
- Expected: Redirect login, API 200. Login with new password succeeds, old password fails. Token single-use (reuse -> 400).

**TC-13 – Reset token expired / invalid:**

- Steps: Use expired token (`expired-token-xyz`) or reuse consumed token.
- Expected: UI “Link expired, request new one”. API 400/410. Password unchanged.

**TC-14 – Reset password mismatch / weak:**

- Steps: On reset page enter New=`Password123!`, Confirm=`Different123!`.
- Expected: UI “Passwords do not match”. API 400 if bypassed. Weak `123` -> 400.

**TC-15 – Invite acceptance happy path:**

- Pre: As admin, `POST /users/invites {email: invitee@example.com, role: member}`.
- Steps: Open Mailpit invite mail, click accept link `/accept-invite?token=<inviteToken>`. Page shows org + role. Set Name=`Invitee`, Password=`Password123!`, Accept.
- Expected: API 201/200, redirect login/dashboard. Login as invitee succeeds. Invite status accepted.

**TC-16 – Invite invalid / expired token:**

- Steps: Visit `/accept-invite?token=invalid123`.
- Expected: UI “Invite invalid or expired”. API 400/404. No account created.

**TC-17 – Invite already accepted reuse:**

- Steps: Reuse token from TC-15.
- Expected: API 410 “Already accepted”. UI error. No duplicate user.

**TC-18 – Session persistence across reload / restart:**

- Steps: Login as member, reload page, close/reopen browser (keep cookies), visit `/dashboard` and `GET /auth/me`.
- Expected: Still authenticated. After `SESSION_TTL` expiry (manipulate DB expires_at to past), expect redirect login + 401.

**TC-19 – RBAC – unauthenticated cannot access protected APIs:**

- Steps: Without cookie, `GET /users`, `GET /deals`, `GET /auth/me`.
- Expected: All 401. UI visiting `/dashboard` redirects to `/login?next=/dashboard`.

**TC-20 – Concurrency – double signup same email race:**

- Steps: Send two parallel `POST /auth/signup` with `race@example.com / Password123!`.
- Expected: One 201, one 409. Only one DB row. No crash. Use script with `&` or k6.

**TC-21 – Concurrency – multiple logins create separate sessions:**

- Steps: Login twice from different cookie jars / browsers as same user.
- Expected: Two session rows. Logout one does not kill other (if design supports multi-session). Else single session invalidates old – document behavior.

**TC-22 – Audit side-effects – login/logout/signup logged:**

- Steps: Perform signup/login/logout, then as admin `GET /audit-logs?action=auth.*`.
- Expected: Entries with actor, IP, UA, timestamp. Verify old/new null for login, user payload for signup.

**TC-23 – Cookie flags & security:**

- Steps: Login, inspect DevTools Application -> Cookies.
- Expected: HttpOnly true, SameSite Lax/Strict, Secure true in prod (false localhost ok), Path=/, Expires matches TTL. No token in localStorage (XSS safe).

**TC-24 – Brute-force / rate limit (if enabled):**

- Steps: 10x rapid wrong password logins for same email.
- Expected: After threshold, 429 Too Many Requests with Retry-After. Valid login after cooldown succeeds. Document if not implemented as gap.

**TC-25 – Empty / loading / error states:**

- Steps: Submit empty login form; throttle network to Slow 3G and click Login; stop API container and click Login.
- Expected: Empty -> required field errors. Loading -> button spinner disabled, no double submit. API down -> “Cannot reach server, try again” banner, no crash.

## 5. API Testing Section (endpoint table + at least 5 curl examples with expected status/body)

**Endpoint table:**

| Method | Path                  | Auth         | Body / Query                     | Success                | Errors                        |
| ------ | --------------------- | ------------ | -------------------------------- | ---------------------- | ----------------------------- |
| POST   | /auth/signup          | No           | `{name,email,password,orgName?}` | 201 user               | 400 validation, 409 duplicate |
| POST   | /auth/login           | No           | `{email,password}`               | 200 user + cookie      | 401 invalid, 403 suspended    |
| POST   | /auth/logout          | Yes (cookie) | –                                | 200 `{ok:true}`        | 401 if no session             |
| GET    | /auth/me              | Yes          | –                                | 200 user               | 401                           |
| POST   | /auth/forgot-password | No           | `{email}`                        | 200 `{ok:true}` always | –                             |
| POST   | /auth/reset-password  | No           | `{token,newPassword}`            | 200                    | 400 invalid/expired/weak      |
| POST   | /auth/accept-invite   | No           | `{token,name,password}`          | 201                    | 400/404/410                   |
| GET    | /auth/sessions        | Yes          | –                                | 200 list               | 401                           |

**Curl 1 – Signup:**

```bash
curl -i -X POST http://localhost:3001/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"name":"Test User","email":"test@example.com","password":"Password123!","orgName":"TC Org"}'
# Expected: 201 {"id":"uuid","email":"test@example.com","name":"Test User"}
```

**Curl 2 – Login + save cookie:**

```bash
curl -i -c cookies.txt -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"member@example.com","password":"Password123!"}'
# Expected: 200 {"id":"...","email":"member@example.com"} + Set-Cookie: nexus_session=...; HttpOnly
```

**Curl 3 – Me (authenticated):**

```bash
curl -i -b cookies.txt http://localhost:3001/auth/me
# Expected: 200 {"email":"member@example.com","role":"member"}
# Without cookie -> 401 {"message":"Unauthorized"}
```

**Curl 4 – Forgot + Reset:**

```bash
curl -i -X POST http://localhost:3001/auth/forgot-password \
  -H "Content-Type: application/json" \
  -d '{"email":"member@example.com"}'
# Expected: 200 {"ok":true} (check Mailpit for token)
curl -i -X POST http://localhost:3001/auth/reset-password \
  -H "Content-Type: application/json" \
  -d '{"token":"<TOKEN_FROM_MAILPIT>","newPassword":"NewPass123!"}'
# Expected: 200 {"ok":true}; reuse -> 400
```

**Curl 5 – Logout + Accept Invite:**

```bash
curl -i -b cookies.txt -c cookies.txt -X POST http://localhost:3001/auth/logout
# Expected: 200 {"ok":true} + Set-Cookie cleared
curl -i -X POST http://localhost:3001/auth/accept-invite \
  -H "Content-Type: application/json" \
  -d '{"token":"<INVITE_TOKEN>","name":"Invitee","password":"Password123!"}'
# Expected: 201 {"email":"invitee@example.com"}
```

**Curl 6 – Negative (wrong password):**

```bash
curl -i -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"member@example.com","password":"WrongPass999!"}'
# Expected: 401 {"message":"Invalid email or password"}
```

## 6. UI Testing Section (navigation path, assertions, empty/loading/error states, responsive, dark mode, keyboard/a11y)

**Navigation paths:**

- `/signup` -> fill -> submit -> assert redirect `/dashboard` or toast “Account created”. Assert header shows avatar.
- `/login` -> fill `test@example.com / Password123!` -> assert dashboard greeting, no console errors.
- Avatar -> Logout -> assert `/login`, avatar gone, protected `/dashboard` redirects.
- `/forgot-password` -> submit -> assert “Check inbox” message (even for unknown). Open Mailpit `http://localhost:8025` -> click link -> `/reset-password` loads.
- `/accept-invite?token=...` -> assert org name, role badge, password fields, Accept -> login.

**Assertions:**

- Inline validation appears on blur/submit; error toast for 401/409; success toast for reset/invite.
- Cookie present after login (DevTools). `GET /auth/me` in Network 200.
- Suspended user sees blocking message, not dashboard.

**Empty/loading/error states:**

- Empty submit -> HTML5 required + custom messages, submit disabled until valid if implemented.
- Loading: Slow 3G -> button shows spinner, double-click does not fire twice (Network shows 1 POST).
- Error: Kill API -> banner “Network error”. Invalid token pages show friendly expired UI + “Resend” button.

**Responsive:**

- 375px mobile: forms full-width, no horizontal scroll, buttons reachable, Mailpit link tappable.
- 768px tablet, 1440px desktop: centered card max-width ~480px, consistent spacing.

**Dark mode:**

- Toggle dark (if in settings/header): inputs, cards, error red still readable (contrast >4.5:1), logo visible.

**Keyboard/a11y:**

- Tab order: email -> password -> submit -> forgot link -> signup link. Enter submits. Esc closes toasts/modals.
- Labels associated (`<label for>`), aria-invalid on error, aria-live for toast, focus moves to first error, Lighthouse a11y >=90.

## 7. Regression & Cross-Feature Impact

- Auth change breaks all: verify 2FA (login with 2FA still prompts), SSO (ssoOnly users cannot password login), Users CRUD (new user can login), Roles (role from invite respected in guards).
- Password reset invalidates old sessions? Verify if all sessions revoked – check `GET /auth/sessions` after reset.
- Org security settings: changing `passwordMinLength` to 12 must reflect in signup/reset validation; `ssoOnly=true` must block password login with clear message.
- Audit logs: ensure auth events still emitted after refactor.
- Rate limiting / session TTL changes affect login/logout tests – re-run TC-18, TC-24.
- Mailpit template changes: reset/invite links must still contain valid token param and WEB_URL.
- Re-run smoke: signup -> login -> me -> logout -> login with new password after reset.

## 8. Expected Results Summary Table

| TC    | Description           | Expected Status / UI          | Data / Side-effect              |
| ----- | --------------------- | ----------------------------- | ------------------------------- |
| TC-01 | Signup happy          | 201 + redirect dashboard      | users row, no plaintext pw      |
| TC-02 | Login happy           | 200 + cookie + dashboard      | sessions row                    |
| TC-03 | Logout                | 200 + redirect login          | session deleted, cookie cleared |
| TC-04 | Invalid email         | 400 + inline error            | no DB row                       |
| TC-05 | Weak pw               | 400 + inline error            | no DB row                       |
| TC-06 | Duplicate             | 409 + banner                  | single row                      |
| TC-07 | Wrong pw              | 401 generic                   | no session, audit failed        |
| TC-08 | Unknown email         | 401 generic                   | no enumeration                  |
| TC-09 | Suspended             | 403 blocked                   | no session                      |
| TC-10 | Forgot happy          | 200 + Mailpit mail            | token row                       |
| TC-11 | Forgot unknown        | 200 but no mail               | no token                        |
| TC-12 | Reset happy           | 200 + login with new works    | token consumed                  |
| TC-13 | Invalid/expired token | 400/410 + expired UI          | pw unchanged                    |
| TC-14 | Mismatch/weak reset   | 400 + UI error                | pw unchanged                    |
| TC-15 | Invite accept         | 201 + login works             | invite accepted                 |
| TC-16 | Invite invalid        | 400/404 + error UI            | no user                         |
| TC-17 | Invite reuse          | 410                           | no duplicate                    |
| TC-18 | Persistence           | stays logged, expiry logs out | expires_at enforced             |
| TC-19 | Unauth guard          | 401 + redirect login          | –                               |
| TC-20 | Race signup           | 1x201 1x409                   | single row                      |
| TC-21 | Multi-session         | 2 rows / documented           | logout isolates                 |
| TC-22 | Audit                 | logs present                  | IP/UA recorded                  |
| TC-23 | Cookie flags          | HttpOnly etc                  | no localStorage token           |
| TC-24 | Rate limit            | 429 after threshold           | recovery ok                     |
| TC-25 | Empty/loading/error   | proper states                 | no crash                        |

## 9. Troubleshooting & Common Failures

- **409 on first signup:** Stale data – `DELETE FROM users WHERE email='test@example.com'` and clear Mailpit.
- **401 on /auth/me after login:** Cookie not sent – ensure curl uses `-b cookies.txt`, frontend `fetch(..., {credentials:'include'})`, CORS `Access-Control-Allow-Credentials:true`, API/Web ports correct.
- **No Mailpit mail:** Check `SMTP_HOST=localhost SMTP_PORT=1025`, containers up (`docker ps`), spam filter search correct address, check `mailpit` logs.
- **Reset/invite link 404:** WEB_URL mismatch – ensure email link uses `http://localhost:3000` not prod; token URL-encoded.
- **Token expired instantly:** Clock skew or TTL env `RESET_TOKEN_TTL_MIN` too low; check DB `expires_at`.
- **CORS error on login:** API `CORS_ORIGIN=http://localhost:3000`, credentials true, no `*` origin.
- **Password validation mismatch UI vs API:** Org `passwordMinLength` changed – reload settings, align frontend regex with backend.
- **Session expires too fast:** `SESSION_TTL_HOURS` misconfigured or Redis eviction – inspect Redis `TTL sess:*`.
- **Redirect loop login<->dashboard:** `GET /auth/me` returns 401 but frontend thinks logged – clear cookies, check cookie domain/path.
- **Invite token invalid:** Already accepted or org mismatch – query `invites` table status, create fresh invite.

## 10. Pass/Fail Checklist (checkbox list)

- [ ] Signup with `test@example.com / Password123!` creates user and logs in (TC-01)
- [ ] Login with `member@example.com / Password123!` sets HttpOnly cookie (TC-02)
- [ ] Logout clears cookie and `/auth/me` -> 401 (TC-03)
- [ ] Invalid email and weak password rejected 400 with inline errors (TC-04/05)
- [ ] Duplicate signup -> 409, no duplicate (TC-06)
- [ ] Wrong password and unknown email both generic 401 (TC-07/08)
- [ ] Suspended user blocked 403 (TC-09)
- [ ] Forgot-password sends Mailpit mail for known, silent for unknown (TC-10/11)
- [ ] Reset with valid token works, reuse/expired fails (TC-12/13)
- [ ] Mismatch/weak reset rejected (TC-14)
- [ ] Invite accept creates account, invalid/reuse rejected (TC-15/16/17)
- [ ] Reload persists session, expired TTL logs out (TC-18)
- [ ] Unauthenticated APIs 401 and UI redirects to login (TC-19)
- [ ] Race signup yields single user (TC-20)
- [ ] Multi-session behavior documented and verified (TC-21)
- [ ] Audit logs contain auth events with IP/UA (TC-22)
- [ ] Cookie flags correct, no token in localStorage (TC-23)
- [ ] Rate limiting verified or gap logged (TC-24)
- [ ] Empty/loading/error states handled (TC-25)
- [ ] All curl examples return expected status/body
- [ ] Responsive (375/768/1440), dark mode, keyboard/a11y pass
- [ ] Regression with 2FA/SSO/users/roles/security settings pass
