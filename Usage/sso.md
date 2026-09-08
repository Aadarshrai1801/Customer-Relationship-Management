# SSO (SAML/OIDC) – Comprehensive Testing Guide

## 1. Overview (what feature does, where in UI/API, related files)

Nexus CRM SSO allows login via enterprise IdP (SAML 2.0 and OIDC) plus admin configuration of SSO connections, domain auto-routing, and default role mapping.

**What it does:**

- User clicks “Login with SSO” on `/login`, enters email/domain, redirected to IdP, callback creates/links user and session.
- Admin CRUDs SSO configs: provider type (saml/oidc), entityID/issuer, SSO URL, certificate, clientId/secret, allowed domains, default role, enforce flag.
- Supports IdP-initiated and SP-initiated flows, JIT provisioning, domain-to-connection matching, `ssoOnly` enforcement.
- Maps IdP groups/claims to Nexus roles.

**Where in UI:**

- Web `http://localhost:3000/login` – “Continue with SSO” button, email/domain input, IdP redirect.
- Web `http://localhost:3000/sso/callback` / `/auth/sso/callback` – handles code/token, error display.
- Web `http://localhost:3000/settings/sso` or `/admin/sso` – admin list, Create/Edit/Delete, test connection, domain + default role fields.
- Web `http://localhost:3000/settings/security` – ssoOnly toggle surfaced.

**Where in API:**

- `GET /sso/configs` (admin), `POST /sso/configs`, `PATCH /sso/configs/:id`, `DELETE /sso/configs/:id`
- `GET /sso/login?domain=example.com&email=user@example.com` -> 302 IdP
- `GET|POST /sso/callback` (SAML ACS / OIDC redirect), `GET /sso/discovery?email=` (domain routing)
- `POST /sso/test/:id` (validate config)

**Related files:**

- `api/src/sso/sso.controller.ts`, `sso.service.ts`, `saml.strategy.ts`, `oidc.strategy.ts`
- `api/src/org/org-security.service.ts` – ssoOnly, domains
- `api/src/users/users.service.ts` – JIT provisioning
- `web/src/app/(auth)/login/page.tsx` (SSO button), `web/src/app/sso/callback/page.tsx`, `web/src/app/settings/sso/page.tsx`
- PRD: SSO, Org Security, JIT.

## 2. Prerequisites & Test Data Setup (infra:up, db:migrate, users/roles, .env keys)

**Infra:**

```bash
docker compose -f infra/docker-compose.yml up -d postgres redis mailpit
npm run db:migrate
npm run dev:api
npm run dev:web
```

Need mock IdP for local: use `keycloak`, `auth0 dev`, `okta preview`, or `samltest.id` / `mock-oidc` container. Simplest: run `docker run -p 8080:8080 ghcr.io/navikt/mock-oauth2-server` for OIDC.

**.env keys:**

- `SSO_ENABLED=true`, `SSO_BASE_URL=http://localhost:3001/sso`
- `OIDC_ISSUER=http://localhost:8080/test`, `OIDC_CLIENT_ID=nexus`, `OIDC_CLIENT_SECRET=test-secret`, `OIDC_REDIRECT_URI=http://localhost:3001/sso/callback`
- `SAML_ENTITY_ID=nexus-crm-local`, `SAML_ACS_URL=http://localhost:3001/sso/callback`, `SAML_IDP_SSO_URL=https://samltest.id/...`, `SAML_CERT=...`
- `WEB_URL=http://localhost:3000`, `DEFAULT_SSO_ROLE=member`

**Users/roles:**

- Admin `admin@example.com / Password123!` – manages configs.
- SSO user `sso.user@example.com` – no password (or random), linked via IdP `sub`/NameID.
- Domain test: `corp.com` mapped to OIDC config; `other.com` unmapped.
- Ensure clean: `DELETE FROM sso_configs WHERE domain='corp.com'` before create tests; `DELETE FROM users WHERE email='sso.user@corp.com'`.

**IdP setup:**

- Create OIDC client with redirect `http://localhost:3001/sso/callback`, scope openid email profile.
- Create SAML app with ACS same, audience `nexus-crm-local`.
- Record test user in IdP: `sso.user@corp.com / IdpPass123!`.

## 3. Test Environment Matrix (roles x browsers, API via curl, mailpit, DB checks)

| Scenario                 | Chrome           | Firefox | API curl  | Mailpit      | DB               |
| ------------------------ | ---------------- | ------- | --------- | ------------ | ---------------- |
| Admin CRUD configs       | Yes              | Smoke   | Yes       | –            | sso_configs rows |
| SP-initiated OIDC login  | Yes              | Yes     | Yes (302) | Welcome mail | users JIT row    |
| SP-initiated SAML        | Yes              | Smoke   | Yes       | –            | linked NameID    |
| IdP-initiated (if supp)  | Yes              | –       | –         | –            | session          |
| Unmapped domain          | Yes – error      | –       | Yes 404   | –            | no user          |
| ssoOnly user pw login    | Yes – blocked    | –       | 403       | –            | flag             |
| Invalid sig/expired code | Yes – error page | –       | 401       | –            | audit fail       |

**API via curl:** Use `-L` sparingly (don’t follow to real IdP blindly); assert 302 Location contains issuer. For callback, replay code only via browser (one-time).
**Mailpit:** JIT welcome mail to `sso.user@corp.com` at `http://localhost:8025`.
**DB:** `SELECT * FROM sso_configs`; `SELECT email,sso_provider,sso_sub FROM users WHERE email LIKE '%corp.com'`.

## 4. Detailed Step-by-Step Test Cases (numbered TC-01, TC-02... at least 20 cases covering: happy path, validation, edge cases, negative, permissions/RBAC, persistence/reload, concurrency, audit side-effects)

**TC-01 – Admin creates OIDC config happy path:**

- Login admin, go `/settings/sso`, New OIDC: Name=`Corp OIDC`, Issuer=`http://localhost:8080/test`, ClientID=`nexus`, Secret=`***`, Domains=`corp.com`, DefaultRole=`member`, Enabled=true. Save.
- Expected: 201, list shows enabled, `GET /sso/configs` contains it.

**TC-02 – Admin creates SAML config happy path:**

- Input: Name=`Corp SAML`, EntityID=`nexus-crm-local`, SSO URL=`https://samltest.id/.../sso`, Cert=`-----BEGIN...`, Domains=`samlcorp.com`, DefaultRole=`member`.
- Expected: 201, Test button passes.

**TC-03 – Discovery routes domain to connection:**

- Steps: On `/login` click SSO, enter `sso.user@corp.com`, Continue.
- Expected: Redirect to OIDC issuer authorize URL with `client_id=nexus&redirect_uri=.../sso/callback`. API `GET /sso/discovery?email=sso.user@corp.com` -> 200 `{provider:oidc, domain:corp.com}`.

**TC-04 – OIDC login happy path (JIT new user):**

- Pre: Ensure `sso.user@corp.com` not exists.
- Steps: Complete IdP login as that user, approve, callback to Nexus.
- Expected: Redirect `http://localhost:3000/dashboard` with session cookie. DB user created role=member, `sso_provider=oidc`. `GET /auth/me` 200.

**TC-05 – OIDC login existing linked user:**

- Pre: User already JIT’d.
- Steps: SSO login again.
- Expected: No duplicate, `last_login` updated, same id. Session new.

**TC-06 – SAML login happy path:**

- Steps: Initiate with `user@samlcorp.com`, complete SAML at samltest.id.
- Expected: Session + dashboard, `sso_provider=saml`, NameID stored.

**TC-07 – Validation – missing issuer/cert rejected:**

- Input: OIDC without issuer, SAML without cert.
- Expected: 400 `issuer required` / `certificate required`. UI inline error, no save.

**TC-08 – Validation – invalid domain format:**

- Input: Domains=`not a domain`, `*.corp` invalid.
- Expected: 400, UI “Enter comma-separated domains like corp.com”.

**TC-09 – Validation – duplicate domain across configs:**

- Pre: `corp.com` mapped to OIDC.
- Steps: Create second config with same domain.
- Expected: 409 “Domain already mapped”. Must edit first.

**TC-10 – Negative – unmapped domain login:**

- Input: `user@unknown.com` via SSO.
- Expected: UI “No SSO configured for this domain, use password”. API 404. No redirect to IdP.

**TC-11 – Negative – IdP invalid signature / bad client secret:**

- Steps: Corrupt cert/secret in config, attempt login.
- Expected: Callback error page “SSO verification failed”. API 401. No session. Audit `sso.login_failed`.

**TC-12 – Negative – expired authorization code replay:**

- Steps: Replay same `?code=...` twice to `/sso/callback`.
- Expected: Second 401/400 “code already used”. Single session.

**TC-13 – Default role mapping applied:**

- Pre: Config DefaultRole=`manager` for `corp.com`.
- Steps: JIT new `newbie@corp.com` via SSO.
- Expected: DB role=manager, UI permissions reflect manager (e.g., can view reports). Change back to member after.

**TC-14 – Group/claim mapping (if supported):**

- Pre: IdP sends `groups=[admins]`, mapping admins->admin.
- Steps: Login as grouped user.
- Expected: Role admin assigned/updated. Document if not supported as gap.

**TC-15 – ssoOnly enforcement blocks password login:**

- Pre: Set user or org `ssoOnly=true`.
- Steps: Try `POST /auth/login {email:sso.user@corp.com,password:any}` and UI password form.
- Expected: 403 “SSO required”. UI hides password or shows redirect prompt.

**TC-16 – RBAC – non-admin cannot CRUD configs:**

- Steps: As member, `GET /sso/configs`, `POST /sso/configs`, visit `/settings/sso`.
- Expected: API 403, UI 404 or “Admin only”. No data leaked (no secret).

**TC-17 – Secrets not exposed in list:**

- Steps: As admin `GET /sso/configs`.
- Expected: `clientSecret` masked (`***`) or omitted; full only on create. SAML private key never returned.

**TC-18 – Disable/delete config blocks logins:**

- Steps: Disable Corp OIDC, try SSO login for `corp.com`.
- Expected: 404/disabled error, no IdP redirect. Re-enable restores. Delete removes row, discovery 404.

**TC-19 – Persistence/reload – callback reload:**

- Steps: After successful callback, reload dashboard; refresh callback URL.
- Expected: Dashboard stays logged (session cookie). Callback replay shows “already handled, go dashboard” not crash.

**TC-20 – Concurrency – double JIT same email race:**

- Steps: Two parallel SSO callbacks for same new email (simulate via API if possible).
- Expected: Single user row (unique constraint), one 200 one 409/200 idempotent.

**TC-21 – Audit side-effects:**

- Steps: Perform create/update/delete config + successful/failed logins; `GET /audit-logs`.
- Expected: `sso.config_created/updated/deleted`, `sso.login_success/failed` with actor, IP, UA, domain.

**TC-22 – Test connection button:**

- Steps: In edit page click Test.
- Expected: Success toast with IdP metadata fetched; failure shows reason (bad issuer/cert). API `POST /sso/test/:id`.

**TC-23 – Logout with SSO (SP SLO if supported):**

- Steps: Login via SSO, click Logout.
- Expected: Nexus session cleared; if SLO, also redirect to IdP logout then back to `/login`. Document if only local logout.

**TC-24 – Empty/loading/error UI:**

- Steps: SSO email empty submit; Slow 3G initiate; stop API and click SSO.
- Expected: Required error, spinner, network banner. Callback error page has “Try again” + support id.

## 5. API Testing Section (endpoint table + at least 5 curl examples with expected status/body)

| Method | Path                  | Auth     | Success           | Errors                     |
| ------ | --------------------- | -------- | ----------------- | -------------------------- |
| GET    | /sso/configs          | admin    | 200 list (masked) | 403 member, 401 anon       |
| POST   | /sso/configs          | admin    | 201 config        | 400 validation, 409 domain |
| PATCH  | /sso/configs/:id      | admin    | 200 updated       | 404, 409                   |
| DELETE | /sso/configs/:id      | admin    | 204               | 404                        |
| GET    | /sso/discovery?email= | No       | 200 provider      | 404 unmapped               |
| GET    | /sso/login?email=     | No       | 302 IdP           | 404/400                    |
| GET    | /sso/callback?code=   | No (IdP) | 302 web + cookie  | 401 bad sig/code           |
| POST   | /sso/test/:id         | admin    | 200 ok            | 400 fail reason            |

**Curl 1 – List (admin vs member):**

```bash
curl -i -b admin_cookies.txt http://localhost:3001/sso/configs
# Expected: 200 [{"id":"...","provider":"oidc","domains":["corp.com"],"clientSecret":"***"}]
curl -i -b member_cookies.txt http://localhost:3001/sso/configs
# Expected: 403 {"message":"Forbidden"}
```

**Curl 2 – Create OIDC:**

```bash
curl -i -b admin_cookies.txt -X POST http://localhost:3001/sso/configs \
 -H "Content-Type: application/json" \
 -d '{"name":"Corp OIDC","provider":"oidc","issuer":"http://localhost:8080/test","clientId":"nexus","clientSecret":"test-secret","redirectUri":"http://localhost:3001/sso/callback","domains":["corp.com"],"defaultRole":"member","enabled":true}'
# Expected: 201 {"id":"...","provider":"oidc"}
```

**Curl 3 – Discovery:**

```bash
curl -i "http://localhost:3001/sso/discovery?email=sso.user@corp.com"
# Expected: 200 {"provider":"oidc","domain":"corp.com","loginUrl":"http://localhost:3001/sso/login?domain=corp.com"}
curl -i "http://localhost:3001/sso/discovery?email=user@unknown.com"
# Expected: 404 {"message":"No SSO for domain"}
```

**Curl 4 – Login redirect:**

```bash
curl -i "http://localhost:3001/sso/login?email=sso.user@corp.com"
# Expected: 302 Location: http://localhost:8080/test/authorize?client_id=nexus&...
```

**Curl 5 – Update + Test:**

```bash
curl -i -b admin_cookies.txt -X PATCH http://localhost:3001/sso/configs/<ID> \
 -H "Content-Type: application/json" -d '{"defaultRole":"manager","enabled":true}'
# Expected: 200 {"defaultRole":"manager"}
curl -i -b admin_cookies.txt -X POST http://localhost:3001/sso/test/<ID>
# Expected: 200 {"ok":true,"issuerValid":true}
```

**Curl 6 – ssoOnly password blocked:**

```bash
curl -i -X POST http://localhost:3001/auth/login \
 -H "Content-Type: application/json" -d '{"email":"sso.user@corp.com","password":"Password123!"}'
# Expected if ssoOnly: 403 {"message":"SSO required for this account"}
```

## 6. UI Testing Section (navigation path, assertions, empty/loading/error states, responsive, dark mode, keyboard/a11y)

**Navigation:**

- `/login` -> “Continue with SSO” -> enter `sso.user@corp.com` -> assert redirect to mock IdP (URL contains issuer) -> login there -> assert back to `http://localhost:3000/dashboard` logged.
- `/settings/sso` (admin) -> list shows provider badges, domains, enabled toggle -> Create -> fill -> Save -> toast -> row appears.
- Callback error: visit `/sso/callback?error=access_denied` -> assert friendly error, not blank.

**Assertions:**

- Discovery error for unknown domain inline, no redirect.
- JIT user avatar/name from IdP claims.
- Secrets inputs type=password with show toggle, never prefilled on edit except placeholder.

**Empty/loading/error:**

- Empty SSO email -> required.
- Loading spinner on Continue/Test, disabled to prevent double.
- IdP down -> callback timeout error with retry.

**Responsive:** SSO button full-width on 375px, config table becomes cards, forms stack.
**Dark mode:** IdP button contrast, QR n/a, error red readable, modal readable.
**Keyboard/a11y:** SSO button focusable, domain input labelled, error aria-live, callback focus to heading, admin toggles keyboard operable.

## 7. Regression & Cross-Feature Impact

- Auth: ssoOnly interacts with password reset (reset must not allow bypass), 2FA (SSO+MFA flow), sessions (SSO sessions same TTL).
- Users: JIT creates user visible in `/users` list with correct role; suspending SSO user blocks next SSO login.
- Roles: defaultRole change affects only new JIT, not existing (verify); group mapping may override.
- Org security: enabling org `ssoOnly` forces all password logins to SSO – re-run auth suite.
- Audit: config changes and logins logged; ensure no secret logged.
- Deleting config must not delete users, only unlink future logins.

## 8. Expected Results Summary Table

| TC    | Description      | Expected                   |
| ----- | ---------------- | -------------------------- |
| TC-01 | Create OIDC      | 201 enabled                |
| TC-02 | Create SAML      | 201 test passes            |
| TC-03 | Discovery        | 200 + IdP redirect         |
| TC-04 | OIDC JIT new     | session + user created     |
| TC-05 | Existing link    | no duplicate               |
| TC-06 | SAML ok          | session                    |
| TC-07 | Missing fields   | 400                        |
| TC-08 | Bad domain       | 400                        |
| TC-09 | Duplicate domain | 409                        |
| TC-10 | Unmapped         | 404 + UI msg               |
| TC-11 | Bad sig          | 401 + error page           |
| TC-12 | Replay code      | 401 second                 |
| TC-13 | Default role     | applied                    |
| TC-14 | Group map        | documented                 |
| TC-15 | ssoOnly block    | 403 pw                     |
| TC-16 | RBAC admin-only  | 403 member                 |
| TC-17 | Secret masked    | ***                        |
| TC-18 | Disable/delete   | blocks, re-enable restores |
| TC-19 | Reload           | stable                     |
| TC-20 | Race JIT         | single row                 |
| TC-21 | Audit            | events                     |
| TC-22 | Test btn         | ok/fail reason             |
| TC-23 | SLO              | local clear min            |
| TC-24 | Empty/loading    | proper                     |

## 9. Troubleshooting & Common Failures

- **Redirect URI mismatch:** IdP error `invalid redirect_uri` – ensure exactly `http://localhost:3001/sso/callback` registered, no trailing slash, http not https locally.
- **Discovery 404 for valid domain:** Case/whitespace – domains lowercased, trim; check enabled=true.
- **401 invalid signature:** Cert expired/wrong (SAML) or secret rotated (OIDC); re-copy, check line breaks `-----BEGIN CERTIFICATE-----`.
- **Code already used:** One-time – restart login, don’t refresh callback.
- **JIT duplicate:** Unique email constraint – search users, link existing via `sso_sub` instead of create.
- **ssoOnly lockout:** No SSO config + ssoOnly true bricks login – admin must disable via DB `UPDATE orgs SET sso_only=false`.
- **Clock skew (SAML NotBefore):** Sync clocks, allow ±5min per spec.
- **CORS/cookie not set after callback:** Callback sets cookie on API domain but web different port – ensure `Set-Cookie Domain=localhost Path=/` and frontend follows redirect with credentials.
- **Secrets exposed:** List returns real secret – mask in DTO, rotate leaked secret immediately.
- **Mock IdP down:** `docker ps`, restart mock-oauth2, verify `http://localhost:8080/test/.well-known/openid-configuration` 200.

## 10. Pass/Fail Checklist (checkbox list)

- [ ] Admin creates OIDC + SAML configs 201 (TC-01/02)
- [ ] Discovery routes `corp.com` to IdP (TC-03)
- [ ] OIDC JIT new user creates session (TC-04)
- [ ] Repeat login no duplicate (TC-05)
- [ ] SAML login works (TC-06)
- [ ] Missing/invalid fields 400 (TC-07/08)
- [ ] Duplicate domain 409 (TC-09)
- [ ] Unmapped domain 404 + UI msg (TC-10)
- [ ] Bad sig/secret 401 (TC-11)
- [ ] Replay code fails second (TC-12)
- [ ] Default role applied (TC-13)
- [ ] Group mapping documented (TC-14)
- [ ] ssoOnly blocks password 403 (TC-15)
- [ ] Non-admin 403, UI hidden (TC-16)
- [ ] Secrets masked (TC-17)
- [ ] Disable/delete blocks, re-enable restores (TC-18)
- [ ] Reload stable (TC-19)
- [ ] Race single row (TC-20)
- [ ] Audit present (TC-21)
- [ ] Test button ok (TC-22)
- [ ] Logout clears (TC-23)
- [ ] Empty/loading/error ok (TC-24)
- [ ] Curls return expected
- [ ] Responsive/dark/a11y pass
