# Security Settings – Comprehensive Testing Guide

## 1. Overview (what feature does, where in UI/API, related files)

Nexus CRM Security Settings hardens auth: 2FA policy (disabled/optional/required), ssoOnly enforcement, passwordMinLength/complexity, session TTL, lockout/rate limits, allowed domains.

**What it does:**

- Admin views/edits via `GET /org/security`, `PATCH /org/security`.
- Fields: `require2fa` (boolean or enum), `ssoOnly` (boolean), `passwordMinLength` (e.g., 8-32), `passwordRequireSymbol` (bool), `sessionTtlHours` (e.g., 1-720), `maxLoginAttempts`, `lockoutMinutes`, `allowedDomains`.
- Enforcement: signup/reset validate length; login blocks password when ssoOnly; session expiry; 2FA required redirect; lockout after fails.

**Where in UI:**

- Web `http://localhost:3000/settings/security` – toggles (Require 2FA, SSO only), sliders/inputs (min length, TTL), Save. Shows impact warnings (“Will log out users”).
- Web surfaced: signup password hint updates, login SSO-only banner, 2FA setup prompt.

**Where in API:**

- `GET /org/security`, `PATCH /org/security`
- Enforced in `POST /auth/signup`, `POST /auth/reset-password`, `POST /auth/login`, `GET /auth/me` (2fa_required), session middleware.

**Related files:**

- `api/src/org/org-security.controller.ts`, `org-security.service.ts`, `dto/update-security.dto.ts`
- `api/src/auth/auth.service.ts` (ssoOnly, length check), `session.service.ts` (TTL)
- `web/src/app/settings/security/page.tsx`
- PRD: Security, Sessions, Password policy.

## 2. Prerequisites & Test Data Setup (infra:up, db:migrate, users/roles, .env keys)

**Infra:**

```bash
docker compose -f infra/docker-compose.yml up -d postgres redis mailpit
npm run db:migrate
npm run dev:api
npm run dev:web
```

**.env:**

- `PASSWORD_MIN_LENGTH=8`, `SESSION_TTL_HOURS=24`, `REQUIRE_2FA=false`, `SSO_ONLY=false`

**Users:**

- Admin `admin@example.com / Password123!`.
- Member `member@example.com / Password123!` (no 2FA initially).
- Member2FA `member2fa@example.com / Password123!` (2FA enabled for required-policy test).
- SSO user `sso.user@corp.com` for ssoOnly test.
- Baseline snapshot: `GET /org/security` save to restore after (critical to avoid lockout).

**DB:**

```sql
SELECT require_2fa,sso_only,password_min_length,session_ttl_hours FROM org_security LIMIT 1;
```

## 3. Test Environment Matrix (roles x browsers, API via curl, mailpit, DB checks)

| Role            | Chrome        | Firefox | API curl         | Mailpit | DB          |
| --------------- | ------------- | ------- | ---------------- | ------- | ----------- |
| Admin edit      | Yes           | Smoke   | 200 PATCH        | –       | row updated |
| Member view     | Yes read-only | –       | 403 PATCH        | –       | –           |
| 2FA user login  | Yes           | Yes     | requires2fa flow | –       | –           |
| ssoOnly user    | Yes banner    | –       | 403 pw           | –       | flag        |
| Expired session | Yes redirect  | –       | 401 me           | –       | expires_at  |

**API:** admin vs member jars. **Mailpit:** password/2FA mails if any. **DB:** policy row + sessions expiry.

## 4. Detailed Step-by-Step Test Cases (numbered TC-01, TC-02... at least 20 cases covering: happy path, validation, edge cases, negative, permissions/RBAC, persistence/reload, concurrency, audit side-effects)

**TC-01 – Get security happy path:**

- As admin open page / `GET /org/security`.
- Expected: 200 with defaults (e.g., min 8, TTL 24, require2fa false, ssoOnly false).

**TC-02 – Set passwordMinLength=12 happy path:**

- `PATCH {passwordMinLength:12}`.
- Expected: 200, signup hint “At least 12 chars”, `POST /auth/signup {password:Password123! (11)}` now 400 (was ok at 8).

**TC-03 – Verify weak still rejected, strong passes:**

- Try `Pass1!` (6) -> 400; `LongPassword123!` (16) -> 201.
- Expected: Boundary 12 passes, 11 fails.

**TC-04 – Enable require2fa=true:**

- `PATCH {require2fa:true}`.
- Expected: Login as `member@example.com` (no 2FA) -> blocked with “Setup 2FA” redirect; login as 2FA user -> OTP then success.

**TC-05 – Disable require2fa restores:**

- `PATCH {require2fa:false}`.
- Expected: Non-2FA login works again, no prompt.

**TC-06 – Enable ssoOnly=true (careful – may lockout):**

- Pre: Ensure SSO config for test domain exists, plus admin bypass if supported.
- `PATCH {ssoOnly:true}` then `POST /auth/login {member@example.com/Password123!}`.
- Expected: 403 “SSO required”. UI password form shows SSO redirect. Disable after to restore.

**TC-07 – Session TTL change:**

- `PATCH {sessionTtlHours:1}` then login, check cookie Expires ~1h and DB expires_at.
- Set back to 24. Manipulate one session to expired, verify `GET /auth/me` 401 + UI redirect.
- Expected: TTL enforced.

**TC-08 – Lockout/attempts if supported:**

- Set `maxLoginAttempts:3, lockoutMinutes:5`, then 3x wrong pw for member.
- Expected: 4th even correct -> 423/429 locked with retry. After 5min or admin unlock, success. Document if not implemented.

**TC-09 – Validation – minLength range:**

- Try `passwordMinLength:4`, `0`, `100`.
- Expected: 400 (allowed 8-32 or 6-64 per spec – record actual). Boundaries pass.

**TC-10 – Validation – TTL range:**

- `sessionTtlHours:0`, `-1`, `10000`.
- Expected: 400 (allowed 1-720). 1 and 720 pass.

**TC-11 – Validation – bad types:**

- `require2fa:maybe`, `ssoOnly:yes-string`.
- Expected: 400, no save.

**TC-12 – RBAC – member PATCH blocked:**

- As member `PATCH /org/security {passwordMinLength:20}`.
- Expected: 403, DB unchanged, UI disabled.

**TC-13 – Edge – existing passwords unaffected:**

- After raising min to 12, login with old 8-char user `OldPass1!` (if exists) still succeeds (only new/reset enforced).
- Expected: Login ok, but reset to short now fails – document.

**TC-14 – Edge – ssoOnly with admin exception:**

- If spec says admins bypass ssoOnly, verify admin pw login still works while member blocked. Else both blocked – record.
- Expected: Document actual behavior to avoid lockout procedure.

**TC-15 – Edge – 2FA required for new signup:**

- With require2fa true, signup `newsec@example.com / Password123!`.
- Expected: Account created but flagged must-setup, dashboard blocked until 2FA enabled.

**TC-16 – Persistence/reload:**

- Change, Save, reload, logout/login – still set. Sessions created after change use new TTL, old keep old or refreshed – document.
- Expected: Consistent.

**TC-17 – Concurrency – two admins patch different fields:**

- A sets min 12, B sets TTL 2 simultaneously.
- Expected: No lost update (merged or last-wins with full object – verify both or one; use PATCH merge correctly).

**TC-18 – Audit – policy changes logged:**

- After each PATCH, `GET /audit-logs?entity=org_security`.
- Expected: old/new (e.g., 8->12) with actor admin.

**TC-19 – Cross-feature – signup/reset messages update:**

- With min 12, UI signup, reset, invite-accept hints all show 12, API errors mention 12.
- Expected: No stale 8 hint anywhere.

**TC-20 – Cross-feature – SSO + 2FA interplay:**

- With both ssoOnly and require2fa true, SSO login still requires OTP (or IdP MFA) – verify flow completes.
- Expected: No bypass; document if SSO skips Nexus 2FA by design.

**TC-21 – Reset baseline (cleanup):**

- Restore `passwordMinLength:8, require2fa:false, ssoOnly:false, sessionTtlHours:24`.
- Expected: Auth suite passes again.

**TC-22 – Empty/loading/error:**

- Clear minLength empty, Slow 3G save, API down.
- Expected: Required/range error, spinner, banner.

## 5. API Testing Section (endpoint table + at least 5 curl examples with expected status/body)

| Method | Path          | Auth                      | Success                 | Errors                      |
| ------ | ------------- | ------------------------- | ----------------------- | --------------------------- |
| GET    | /org/security | admin (maybe member read) | 200                     | 401 anon, 403 if admin-only |
| PATCH  | /org/security | admin                     | 200                     | 400 validation, 403 member  |
| POST   | /auth/signup  | No                        | 201 if meets length     | 400 short                   |
| POST   | /auth/login   | No                        | 200 or 403 ssoOnly      | 403/401                     |
| GET    | /auth/me      | cookie                    | 200 or 403 2fa_required | 401 expired                 |

**Curl 1 – Get:**

```bash
curl -i -b admin_cookies.txt http://localhost:3001/org/security
# Expected: 200 {"passwordMinLength":8,"sessionTtlHours":24,"require2fa":false,"ssoOnly":false}
```

**Curl 2 – Set minLength:**

```bash
curl -i -b admin_cookies.txt -X PATCH http://localhost:3001/org/security \
 -H "Content-Type: application/json" -d '{"passwordMinLength":12}'
# Expected: 200 {"passwordMinLength":12}
curl -i -X POST http://localhost:3001/auth/signup \
 -H "Content-Type: application/json" -d '{"name":"T","email":"shortlen@example.com","password":"Pass123!"}'
# Expected if 8 chars <12: 400 {"message":"Password must be at least 12 characters"}
```

**Curl 3 – Require2FA:**

```bash
curl -i -b admin_cookies.txt -X PATCH http://localhost:3001/org/security \
 -H "Content-Type: application/json" -d '{"require2fa":true}'
# Expected: 200
curl -i -c tmp.txt -X POST http://localhost:3001/auth/login \
 -H "Content-Type: application/json" -d '{"email":"member@example.com","password":"Password123!"}'
# Expected: 403 {"code":"2fa_required"} or 200 requires2fa (document)
```

**Curl 4 – SSOOnly:**

```bash
curl -i -b admin_cookies.txt -X PATCH http://localhost:3001/org/security \
 -H "Content-Type: application/json" -d '{"ssoOnly":true}'
# Expected: 200
curl -i -X POST http://localhost:3001/auth/login \
 -H "Content-Type: application/json" -d '{"email":"member@example.com","password":"Password123!"}'
# Expected: 403 {"message":"SSO required"}
# Restore:
curl -i -b admin_cookies.txt -X PATCH http://localhost:3001/org/security -H "Content-Type: application/json" -d '{"ssoOnly":false,"require2fa":false,"passwordMinLength":8}'
```

**Curl 5 – TTL:**

```bash
curl -i -b admin_cookies.txt -X PATCH http://localhost:3001/org/security \
 -H "Content-Type: application/json" -d '{"sessionTtlHours":1}'
# Expected: 200; next login cookie Max-Age ~3600
```

**Curl 6 – RBAC:**

```bash
curl -i -b member_cookies.txt -X PATCH http://localhost:3001/org/security \
 -H "Content-Type: application/json" -d '{"passwordMinLength":20}'
# Expected: 403
```

## 6. UI Testing Section (navigation path, assertions, empty/loading/error states, responsive, dark mode, keyboard/a11y)

**Navigation:** `/settings/security` -> toggles Require 2FA, SSO Only, inputs Min length, TTL, attempts. Save -> confirm modal if impactful (“Will affect logins”) -> toast.
**Assertions:** Signup hint updates to 12, login SSO banner appears when ssoOnly, 2FA prompt when required, TTL helper “Sessions expire after X hours”.
**Empty:** Clearing min/TTL shows required/range, Save disabled until valid.
**Loading:** Save spinner, toggles optimistic with rollback on fail.
**Error:** Validation inline, API down banner, ssoOnly enable warns lockout with “I understand” checkbox.
**Responsive:** 375px stacked, toggles reachable, Save sticky.
**Dark mode:** Toggles, inputs, warnings readable.
**Keyboard/a11y:** Toggles Space/Enter, inputs labelled, warnings aria-live, focus to error.

## 7. Regression & Cross-Feature Impact

- Auth: re-run full auth suite after each policy change and after restore – signup/login/reset/sessions.
- 2FA: require flag changes login flow – re-run 2FA suite.
- SSO: ssoOnly changes password login – re-run SSO suite.
- Users: new invites must meet length; existing short passwords still login (verify).
- Audit: policy edits logged.
- Must restore baseline or subsequent suites fail (especially ssoOnly/require2fa left on).

## 8. Expected Results Summary Table

| TC    | Desc              | Expected        |
| ----- | ----------------- | --------------- |
| TC-01 | Get               | 200 defaults    |
| TC-02 | Min 12            | enforced        |
| TC-03 | Boundary          | 11 fail 12 pass |
| TC-04 | Require2fa        | block non-2FA   |
| TC-05 | Disable restores  | ok              |
| TC-06 | ssoOnly           | 403 pw          |
| TC-07 | TTL               | expiry enforced |
| TC-08 | Lockout           | 423/429 or gap  |
| TC-09 | Min range         | 400             |
| TC-10 | TTL range         | 400             |
| TC-11 | Types             | 400             |
| TC-12 | Member 403        | unchanged       |
| TC-13 | Old pw login      | still ok        |
| TC-14 | Admin bypass      | documented      |
| TC-15 | Signup must-setup | blocked dash    |
| TC-16 | Persist           | consistent      |
| TC-17 | Race              | no lost         |
| TC-18 | Audit             | diff logged     |
| TC-19 | Hints update      | all places      |
| TC-20 | SSO+2FA           | no bypass       |
| TC-21 | Restore           | suite green     |
| TC-22 | Empty/loading     | proper          |

## 9. Troubleshooting & Common Failures

- **Locked out by ssoOnly (no SSO):** Direct DB `UPDATE org_security SET sso_only=false`, restart api if cached, clear cookies.
- **Require2fa bricks member tests:** Use 2FA user or disable via DB `UPDATE org_security SET require_2fa=false`.
- **MinLength not enforced on signup:** Backend reads stale cache – restart api, check DTO `MinLength` uses dynamic config not hardcoded 8.
- **TTL not reflected in cookie:** `Set-Cookie Max-Age` still old – check session service reads DB per login, not env only.
- **PATCH 400 on valid:** Range enum mismatch (e.g., min 12 but max 10 in DTO) – inspect validation pipe message.
- **UI hint still 8 after 12:** Hardcoded frontend string – bind to `GET /org/security`.
- **Concurrent PATCH lost:** PUT full replace vs PATCH merge – always PATCH single field, re-GET before edit.
- **Audit missing:** Entity name `org_security` vs `org` – query both.

## 10. Pass/Fail Checklist (checkbox list)

- [ ] Get defaults (TC-01)
- [ ] Min 12 enforced signup/reset (TC-02/03/19)
- [ ] Require2fa blocks non-2FA (TC-04)
- [ ] Disable restores (TC-05)
- [ ] ssoOnly blocks pw 403 (TC-06)
- [ ] TTL expiry (TC-07)
- [ ] Lockout or gap logged (TC-08)
- [ ] Ranges 400, boundaries pass (TC-09/10)
- [ ] Types 400 (TC-11)
- [ ] Member 403 (TC-12)
- [ ] Old pw still login (TC-13)
- [ ] Admin bypass documented (TC-14)
- [ ] Signup must-setup (TC-15)
- [ ] Persist (TC-16)
- [ ] Race safe (TC-17)
- [ ] Audit diff (TC-18)
- [ ] SSO+2FA no bypass (TC-20)
- [ ] Baseline restored (TC-21)
- [ ] Empty/loading ok (TC-22)
- [ ] Curls pass, responsive/dark/a11y pass
