# Two-Factor Auth (2FA) – Comprehensive Testing Guide

## 1. Overview (what feature does, where in UI/API, related files)

Nexus CRM Two-Factor Auth adds TOTP-based second factor plus backup codes. Users can setup, verify, enable, and disable 2FA; login flow challenges with OTP when enabled; org can enforce via policy.

**What it does:**

- `POST /auth/2fa/setup` generates TOTP secret + otpauth:// URI + QR payload, stores temp secret.
- `POST /auth/2fa/verify-setup` verifies 6-digit code from authenticator to enable.
- `POST /auth/2fa/verify` verifies OTP during login challenge (with temp session token).
- `POST /auth/2fa/disable` disables after password + OTP confirmation.
- `POST /auth/2fa/backup-codes/regenerate` issues 10 single-use codes; `POST /auth/2fa/backup-verify` allows login via backup code.
- Login flow: `POST /auth/login` with 2FA user returns `{"requires2fa":true,"tempToken":"..."}` 200/202 instead of session, then OTP step completes session.

**Where in UI:**

- Web `http://localhost:3000/settings/security` or `/profile/security` – 2FA section: Status badge, Setup button, QR modal, code input, backup codes list with Copy/Download, Disable button.
- Web `http://localhost:3000/login` – after password, shows “Enter 6-digit code” step + “Use backup code” link.
- Web `http://localhost:3000/settings/security` – enforcement notice if org requires 2FA.

**Where in API:**

- `POST /auth/2fa/setup`, `POST /auth/2fa/verify-setup`, `POST /auth/2fa/verify`, `POST /auth/2fa/disable`, `GET /auth/2fa/status`, `POST /auth/2fa/backup-codes/regenerate`, `POST /auth/2fa/backup-verify`.

**Related files:**

- `api/src/auth/two-factor/*` – `two-factor.controller.ts`, `two-factor.service.ts` (speakeasy/otplib), backup code hashing.
- `api/src/auth/auth.service.ts` – login branching for 2FA.
- `api/src/users/users.entity.ts` – `twoFactorEnabled`, `twoFactorSecret` (encrypted).
- `web/src/app/settings/security/page.tsx`, `web/src/components/TwoFactorSetup.tsx`, `QrCode.tsx`.
- PRD: Security / 2FA, backup codes.

## 2. Prerequisites & Test Data Setup (infra:up, db:migrate, users/roles, .env keys)

**Infra:**

```bash
docker compose -f infra/docker-compose.yml up -d postgres redis mailpit
npm run db:migrate
npm run dev:api
npm run dev:web
```

Ensure time sync (TOTP needs ±30s). Use real authenticator (Google Authenticator/Authy) or `oathtool` for tests.

**.env keys:**

- `TWO_FACTOR_ENCRYPTION_KEY=32byte-test-key-...` (secret encryption)
- `TWO_FACTOR_ISSUER=NexusCRM`, `BACKUP_CODE_COUNT=10`, `BACKUP_CODE_LENGTH=8`
- `SESSION_TTL_HOURS=24`, `2FA_TEMP_TOKEN_TTL_MIN=5`
- `ORG_ENFORCE_2FA=false` default (toggle for policy tests)

**Users/roles:**

- `member2fa@example.com / Password123!` – clean user with 2FA disabled initially (delete secret: `UPDATE users SET two_factor_enabled=false WHERE email='...'`).
- `admin@example.com / Password123!` – to test enforce policy change.
- `member@example.com / Password123!` – control without 2FA.
- Install TOTP helper: `npm i -g otplib` or python `oathtool --base32 --totp <SECRET>` for expected code.

**Test data setup:**

- Login as member2fa to get cookies.txt.
- Ensure no leftover temp secrets: `DELETE FROM two_factor_temp WHERE user_id='...'`.
- Record backup codes securely in temp file for single-use tests.

## 3. Test Environment Matrix (roles x browsers, API via curl, mailpit, DB checks)

| Role                 | Chrome                | Firefox | API curl + oathtool | Mailpit              | DB checks                       |
| -------------------- | --------------------- | ------- | ------------------- | -------------------- | ------------------------------- |
| Member (no 2FA)      | Yes – setup flow      | Yes     | Yes – setup/verify  | Optional notify mail | `twoFactorEnabled=false`        |
| Member (2FA enabled) | Yes – login challenge | Yes     | Yes – login+verify  | –                    | secret encrypted, backup hashes |
| Admin enforcing 2FA  | Yes – policy banner   | Smoke   | Yes – policy API    | –                    | org security column             |
| Suspended with 2FA   | –                     | –       | Yes – still blocked | –                    | –                               |
| Expired tempToken    | Yes                   | –       | Yes – 401/410       | –                    | temp expiry                     |

**API via curl:** Use cookies + tempToken. Generate OTP via `oathtool --base32 --totp $SECRET`.
**Mailpit:** If 2FA enable/disable sends notification mail, verify at `http://localhost:8025`.
**DB checks:** `SELECT email,two_factor_enabled FROM users`; `SELECT * FROM backup_codes WHERE user_id=...`; ensure secret not plaintext.
**Browsers:** Full QR scan on Chrome mobile-emulated + desktop; smoke Firefox.

## 4. Detailed Step-by-Step Test Cases (numbered TC-01, TC-02... at least 20 cases covering: happy path, validation, edge cases, negative, permissions/RBAC, persistence/reload, concurrency, audit side-effects)

**TC-01 – Setup generates secret + QR:**

- Login as `member2fa@example.com`. `POST /auth/2fa/setup`.
- Expected: 200 `{secret, otpauthUrl, qrDataUrl}`. UI shows QR + manual key. DB temp secret stored, `twoFactorEnabled` still false.

**TC-02 – Verify-setup happy path enables 2FA:**

- Input: Current TOTP from authenticator for secret in TC-01.
- Steps: Enter 6-digit in UI, Submit or `POST /auth/2fa/verify-setup {code}`.
- Expected: 200 `{enabled:true, backupCodes:[10 codes]}`. UI shows success + backup codes once. DB `twoFactorEnabled=true`.

**TC-03 – Login with 2FA challenges OTP:**

- Steps: Logout, login via `/login` with `member2fa@example.com / Password123!`.
- Expected: Not dashboard; shows OTP step. API `POST /auth/login` -> 200 `{requires2fa:true,tempToken}`. No session cookie yet.

**TC-04 – Verify OTP login completes session:**

- Steps: On OTP screen enter valid 6-digit, Submit (`POST /auth/2fa/verify {tempToken,code}`).
- Expected: 200 + session cookie, redirect dashboard. `GET /auth/me` 200.

**TC-05 – Wrong OTP rejected:**

- Input: `000000` or off-by-one code.
- Expected: UI “Invalid code, try again”. API 401. No session. Retry with correct still works (unless lockout).

**TC-06 – Expired tempToken rejected:**

- Steps: Get tempToken, wait >5min (or manipulate DB expiry), then verify with correct OTP.
- Expected: 401/410 “Session expired, login again”. UI back to login.

**TC-07 – Backup code login happy path:**

- Pre: Save backup codes from TC-02 (e.g., `a1b2-c3d4`).
- Steps: On OTP screen click “Use backup code”, enter one code.
- Expected: Login succeeds, that code marked used (reuse fails). UI warns remaining count.

**TC-08 – Backup code reuse fails:**

- Steps: Reuse same backup code second login.
- Expected: 401 “Invalid backup code”. DB `used=true`.

**TC-09 – Regenerate backup codes invalidates old:**

- Steps: Logged in, `POST /auth/2fa/backup-codes/regenerate` (confirm password+OTP).
- Expected: New 10 codes, old unused codes now 401. UI shows new list once, download works.

**TC-10 – Disable 2FA happy path:**

- Steps: In security page click Disable, enter password `Password123!` + current OTP, Confirm.
- Expected: 200 `{enabled:false}`. DB flag false, secrets/codes cleared. Next login no OTP.

**TC-11 – Disable with wrong password/OTP fails:**

- Input: Wrong password or wrong OTP.
- Expected: 401/403, 2FA stays enabled. UI error, no state change.

**TC-12 – Setup validation – invalid code:**

- Pre: Fresh user without 2FA, new setup secret.
- Input: `12345` (5 digits), `abcdef`, empty.
- Expected: 400 validation, not enabled. UI inline error.

**TC-13 – TOTP time-window edge (clock skew):**

- Steps: Generate code with ±30s drift (use `oathtool` with previous window if allowed).
- Expected: Document if ±1 step accepted (common). Test with 2-min old code -> must fail.

**TC-14 – QR/manual key edge:**

- Steps: Copy manual secret, add manually in authenticator vs scanning QR.
- Expected: Both produce same valid codes. otpauthUrl contains `issuer=NexusCRM&account=member2fa@example.com`.

**TC-15 – RBAC – user cannot manage another’s 2FA:**

- Steps: As member A, try `POST /auth/2fa/disable` for user B id or `GET /auth/2fa/status?userId=B`.
- Expected: 403/404 or scoped to self only. No cross-user effect. Admin cannot disable others without explicit admin endpoint (document).

**TC-16 – Enforced 2FA policy blocks login without setup:**

- Pre: As admin set org `require2fa=true` (via `PATCH /org/settings`).
- Steps: Login as `member@example.com` (no 2FA).
- Expected: Redirect/banner “2FA required, please setup” and block dashboard until enabled. API `GET /auth/me` maybe 403 `2fa_required`. Disable policy reverts.

**TC-17 – Persistence/reload during setup/login:**

- Steps: During QR step reload page – temp secret retained or regenerated cleanly? During OTP login reload – tempToken in memory lost -> must login again gracefully.
- Expected: No stuck state, clear messages, no duplicate secrets.

**TC-18 – Concurrency – double verify-setup race:**

- Steps: Send two parallel verify-setup with same valid code.
- Expected: One success, one idempotent success or 409, but single backup set, no duplicate. No crash.

**TC-19 – Audit side-effects:**

- Steps: Enable, login via OTP, disable, regenerate codes; check `GET /audit-logs` as admin.
- Expected: Events `2fa.enabled/disabled/login_success/login_failed/backup_used` with IP/UA.

**TC-20 – Backup codes persistence & download:**

- Steps: After enable, click Download/Copy, logout, verify file contains 10 codes, each usable once.
- Expected: File correct, codes hashed in DB (not plaintext), used flag updates.

**TC-21 – Empty/loading states:**

- Steps: Submit empty OTP; throttle to Slow 3G and submit; stop API and submit.
- Expected: Required error, spinner/disabled, network error banner.

**TC-22 – Rate limit / lockout on OTP brute force:**

- Steps: 10x wrong OTP rapidly.
- Expected: 429 or temporary lock (document). Correct code after cooldown works.

**TC-23 – Secret encryption check:**

- Steps: Query DB secret column.
- Expected: Not base32 plaintext; encrypted/blob. Codebase uses encryption key, not plain.

**TC-24 – Logout/invalidate 2FA session:**

- Steps: Login via 2FA, logout, try reuse tempToken or session cookie.
- Expected: Both invalid (401). New login requires OTP again.

## 5. API Testing Section (endpoint table + at least 5 curl examples with expected status/body)

| Method | Path                              | Auth      | Success                   | Errors                   |
| ------ | --------------------------------- | --------- | ------------------------- | ------------------------ |
| POST   | /auth/2fa/setup                   | Yes       | 200 secret+url            | 401, 409 already enabled |
| POST   | /auth/2fa/verify-setup            | Yes       | 200 enabled+codes         | 400 bad code             |
| POST   | /auth/login (2fa user)            | No        | 200 requires2fa+tempToken | 401                      |
| POST   | /auth/2fa/verify                  | tempToken | 200 session cookie        | 401 bad/expired          |
| POST   | /auth/2fa/backup-verify           | tempToken | 200 session               | 401 reused               |
| POST   | /auth/2fa/disable                 | Yes       | 200 disabled              | 401 wrong pw/otp         |
| GET    | /auth/2fa/status                  | Yes       | 200 {enabled}             | 401                      |
| POST   | /auth/2fa/backup-codes/regenerate | Yes       | 200 new codes             | 401                      |

**Curl 1 – Setup:**

```bash
curl -i -b cookies.txt -X POST http://localhost:3001/auth/2fa/setup
# Expected: 200 {"secret":"JBSW...","otpauthUrl":"otpauth://totp/NexusCRM:member2fa@example.com?...","qrDataUrl":"data:image/png..."}
```

**Curl 2 – Verify setup (generate code first):**

```bash
CODE=$(oathtool --base32 --totp $SECRET)
curl -i -b cookies.txt -X POST http://localhost:3001/auth/2fa/verify-setup \
 -H "Content-Type: application/json" -d "{\"code\":\"$CODE\"}"
# Expected: 200 {"enabled":true,"backupCodes":["xxxx-xxxx",...10]}
```

**Curl 3 – Login challenge:**

```bash
curl -i -c cookies2.txt -X POST http://localhost:3001/auth/login \
 -H "Content-Type: application/json" -d '{"email":"member2fa@example.com","password":"Password123!"}'
# Expected: 200 {"requires2fa":true,"tempToken":"..."} (no session cookie yet)
```

**Curl 4 – Verify OTP:**

```bash
CODE=$(oathtool --base32 --totp $SECRET)
curl -i -c cookies2.txt -X POST http://localhost:3001/auth/2fa/verify \
 -H "Content-Type: application/json" -d "{\"tempToken\":\"<TEMP>\",\"code\":\"$CODE\"}"
# Expected: 200 + Set-Cookie session; wrong -> 401
```

**Curl 5 – Backup verify + Disable:**

```bash
curl -i -X POST http://localhost:3001/auth/2fa/backup-verify \
 -H "Content-Type: application/json" -d '{"tempToken":"<TEMP>","backupCode":"<CODE1>"}'
# Expected: 200 session; reuse same -> 401
curl -i -b cookies.txt -X POST http://localhost:3001/auth/2fa/disable \
 -H "Content-Type: application/json" -d '{"password":"Password123!","code":"<CURRENT_TOTP>"}'
# Expected: 200 {"enabled":false}
```

**Curl 6 – Status:**

```bash
curl -i -b cookies.txt http://localhost:3001/auth/2fa/status
# Expected: 200 {"enabled":true,"backupRemaining":9}
```

## 6. UI Testing Section (navigation path, assertions, empty/loading/error states, responsive, dark mode, keyboard/a11y)

**Navigation:**

- Login as member2fa -> `/settings/security` -> assert 2FA card shows Disabled -> Setup -> modal QR visible -> enter code -> success + backup codes modal with Copy/Download/Print.
- Logout -> `/login` -> password -> OTP step appears (6 boxes or single input) -> “Use backup code” toggles -> success redirects dashboard.
- Disable flow: security page -> Disable -> confirm modal (password+code) -> status Disabled.

**Assertions:**

- QR loads, manual key copy button copies, invalid code shows red error without closing modal, backup codes shown only once with warning.
- Remaining backup count displayed; regenerate warns old invalid.
- Enforced org shows banner blocking dashboard.

**Empty/loading/error:**

- Empty OTP -> “Code required”, 5-digit -> “Must be 6 digits”.
- Loading spinner on Verify, prevents double submit.
- API down -> banner, QR retry button.

**Responsive:** 375px QR scales, code inputs not overflow, backup list scrolls, buttons stacked.
**Dark mode:** QR has white background padding for scanability, codes readable, error contrast ok.
**Keyboard/a11y:** OTP inputs auto-advance, Backspace moves back, paste 6-digit fills all, screen reader labels, focus trap in modal, Esc closes (except backup warning requires ack).

## 7. Regression & Cross-Feature Impact

- Auth: password reset must preserve 2FA (still required after reset) or explicitly revoke – verify and document.
- SSO users: if SSO login + 2FA enforced, ensure SSO flow also challenges OTP or defers to IdP MFA – test.
- Security settings `require2fa` toggle immediately affects login; audit logs capture policy change.
- Backup codes usable only once; password change should not invalidate 2FA.
- Session TTL still applies after 2FA login; logout clears.
- Re-run auth suite (signup/login/sessions) with 2FA user to ensure no bypass via `/auth/me` or token replay.

## 8. Expected Results Summary Table

| TC    | Description         | Expected                            |
| ----- | ------------------- | ----------------------------------- |
| TC-01 | Setup secret        | 200 QR + temp, not yet enabled      |
| TC-02 | Verify-setup        | 200 enabled + 10 codes              |
| TC-03 | Login challenge     | requires2fa + tempToken, no session |
| TC-04 | OTP verify          | session + dashboard                 |
| TC-05 | Wrong OTP           | 401, no session                     |
| TC-06 | Expired temp        | 410, re-login                       |
| TC-07 | Backup login        | success, mark used                  |
| TC-08 | Backup reuse        | 401                                 |
| TC-09 | Regenerate          | new set, old invalid                |
| TC-10 | Disable ok          | disabled, no OTP next login         |
| TC-11 | Disable wrong       | stays enabled                       |
| TC-12 | Invalid code format | 400                                 |
| TC-13 | Clock skew          | old fails, ±1 documented            |
| TC-14 | QR/manual parity    | same codes                          |
| TC-15 | RBAC self-only      | 403 cross-user                      |
| TC-16 | Enforce policy      | block without 2FA                   |
| TC-17 | Reload resilience   | graceful, no stuck                  |
| TC-18 | Race verify         | single set, no crash                |
| TC-19 | Audit               | events with IP/UA                   |
| TC-20 | Download/persist    | file ok, hashed DB                  |
| TC-21 | Empty/loading       | proper states                       |
| TC-22 | Brute limit         | 429/lock then recover               |
| TC-23 | Encryption          | secret encrypted                    |
| TC-24 | Logout invalidates  | 401 reuse                           |

## 9. Troubleshooting & Common Failures

- **Always invalid code:** System clock off >30s – sync via `w32tm /resync`, check `oathtool` secret correct (no spaces), ensure server time UTC.
- **QR not scannable in dark mode:** Missing white padding – add `bg-white p-4` wrapper; test with phone.
- **Setup 409 already enabled:** Disable first or use fresh user; query `two_factor_enabled`.
- **tempToken expired instantly:** `2FA_TEMP_TOKEN_TTL_MIN` too low or Redis TTL; increase to 5-10 for tests.
- **Backup code always 401:** Already used, regenerated, or dash/space mismatch – trim, case-insensitive compare.
- **Login bypasses OTP:** Frontend caches session – clear cookies, verify backend `requires2fa` branch, check `twoFactorEnabled` true in DB.
- **Secret plaintext in DB:** Missing encryption key – set `TWO_FACTOR_ENCRYPTION_KEY`, re-run setup, verify blob.
- **Rate limit never triggers:** Feature not implemented – log gap, ensure audit still records failures.
- **Mail not received on enable:** Check SMTP/Mailpit, notification toggle.
- **Focus/paste broken:** OTP component not handling paste – file UI bug, workaround single input.

## 10. Pass/Fail Checklist (checkbox list)

- [ ] Setup returns secret+QR, not yet enabled (TC-01)
- [ ] Valid TOTP enables and returns 10 backup codes (TC-02)
- [ ] 2FA login returns tempToken, no session (TC-03)
- [ ] Valid OTP completes login + cookie (TC-04)
- [ ] Wrong OTP 401, no session (TC-05)
- [ ] Expired temp rejected (TC-06)
- [ ] Backup login works once, reuse fails (TC-07/08)
- [ ] Regenerate invalidates old (TC-09)
- [ ] Disable with pw+OTP works, wrong fails (TC-10/11)
- [ ] Invalid formats 400 (TC-12)
- [ ] Clock skew documented (TC-13)
- [ ] QR/manual parity (TC-14)
- [ ] No cross-user 2FA management (TC-15)
- [ ] Enforce policy blocks non-2FA (TC-16)
- [ ] Reload handled (TC-17)
- [ ] Race safe (TC-18)
- [ ] Audit events present (TC-19)
- [ ] Download/hashing correct (TC-20)
- [ ] Empty/loading/error ok (TC-21)
- [ ] Brute limit or gap logged (TC-22)
- [ ] Secret encrypted (TC-23)
- [ ] Logout invalidates (TC-24)
- [ ] Curl examples all pass
- [ ] Responsive/dark/a11y pass
