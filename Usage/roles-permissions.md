# Roles & Permissions (RBAC) – Comprehensive Testing Guide

## 1. Overview (what feature does, where in UI/API, related files)

Nexus CRM RBAC controls who can do what: roles (admin/manager/member/viewer/custom), scopes (users:read, deals:write, reports:read...), plus record-level (owner/team) and field-level (e.g., salary hidden) enforcement in UI and API and reports.

**What it does:**

- Defines roles with permission sets via `GET /roles`, `POST /roles`, `PATCH /roles/:id`.
- Assigns role to user (`PATCH /users/:id {role}`); guards check `requiredScopes` per endpoint.
- Record-level: e.g., member sees only own deals, manager sees team, admin all.
- Field-level: e.g., `deal.value` hidden for viewer, `user.salary` admin-only.
- UI hides/disables forbidden buttons/menus/routes; API returns 403; reports filter rows/columns.

**Where in UI:**

- Web `http://localhost:3000/settings/roles` – role list, Create, permission matrix checkboxes (scopes x roles), record/field rules.
- Web gated places: Team page (admin only), Reports export (manager+), Deal delete (owner/admin), Settings (admin).
- Web 403 page `/403` for direct URL access.

**Where in API:**

- `GET /roles`, `POST /roles`, `PATCH /roles/:id`, `DELETE /roles/:id`
- `GET /permissions/me`, `GET /users/:id` (filtered fields)
- Guarded: `GET /users` (users:read), `POST /deals` (deals:write), `GET /reports/*` (reports:read), `DELETE /deals/:id` (owner check)
- `GET /deals?owner=me` scoping

**Related files:**

- `api/src/roles/roles.controller.ts`, `roles.service.ts`, `permissions.ts`, `scopes.decorator.ts`
- `api/src/auth/guards/roles.guard.ts`, `scopes.guard.ts`, `record.guard.ts`
- `api/src/deals/deals.service.ts` (owner filter), `api/src/reports/*` (row/col filter)
- `web/src/lib/permissions.ts`, `components/Can.tsx`, `app/settings/roles/page.tsx`
- PRD: RBAC, Record/Field perms.

## 2. Prerequisites & Test Data Setup (infra:up, db:migrate, users/roles, .env keys)

**Infra:**

```bash
docker compose -f infra/docker-compose.yml up -d postgres redis mailpit
npm run db:migrate
npm run dev:api
npm run dev:web
```

**.env:**

- `RBAC_ENABLED=true`, `DEFAULT_ROLE=member`
- No extra keys, but ensure `SESSION_TTL` ok.

**Users/roles:**

- `admin@example.com / Password123!` role admin.
- `manager@example.com / Password123!` role manager (team A).
- `member@example.com / Password123!` role member (owner of Deal M1).
- `viewer@example.com / Password123!` role viewer (read-only).
- Custom `support@example.com` if custom role tested.
- Deals: `Deal Admin1` owner admin, `Deal M1` owner member, `Deal Mgr1` owner manager, with values 1000/5000/9000.
- Sensitive field: `deal.internalNotes` or `contact.salary` admin/manager only.

**Setup SQL:**

```sql
SELECT email,role FROM users;
SELECT id,title,owner_id,value FROM deals;
SELECT * FROM roles;
```

## 3. Test Environment Matrix (roles x browsers, API via curl, mailpit, DB checks)

| Role      | Chrome full          | Firefox smoke | API curl                       | Reports       | DB           |
| --------- | -------------------- | ------------- | ------------------------------ | ------------- | ------------ |
| Admin     | Yes – all visible    | Yes           | 200 all                        | All rows/cols | –            |
| Manager   | Yes – team + reports | Smoke         | 200 team, 403 users:write      | Team rows     | owner filter |
| Member    | Yes – own only       | Yes           | 200 own, 403 others            | Own rows      | –            |
| Viewer    | Yes – read, no edit  | –             | 200 GET, 403 POST/PATCH/DELETE | Masked cols   | field mask   |
| Anonymous | Redirect login       | –             | 401                            | 401           | –            |

**API:** separate cookie jars per role. **Mailpit:** n/a (except role-change notify if enabled). **DB:** role/scopes join.

## 4. Detailed Step-by-Step Test Cases (numbered TC-01, TC-02... at least 20 cases covering: happy path, validation, edge cases, negative, permissions/RBAC, persistence/reload, concurrency, audit side-effects)

**TC-01 – Admin full access happy path:**

- As admin list users, create deal, delete any deal, view reports with all columns, manage roles.
- Expected: All 200, all buttons visible.

**TC-02 – Manager team scope:**

- As manager `GET /deals` – should see team deals (Mgr1 + M1 if same team) but not Admin1 if different team (per rule).
- Expected: Filtered list, UI no Team-admin menu.

**TC-03 – Member own-only record:**

- As member `GET /deals` – only M1. `GET /deals/<AdminId>` -> 403. `DELETE /deals/<AdminId>` -> 403.
- Expected: Correct scoping, UI edit only on own row.

**TC-04 – Viewer read-only:**

- As viewer `GET /deals` 200, `POST /deals` 403, `PATCH` 403, `DELETE` 403.
- Expected: UI all inputs disabled, New/Save hidden, table read.

**TC-05 – Field-level masking:**

- As viewer `GET /deals/<id>` – `value`/`internalNotes` missing or `***`. As admin full present.
- Expected: API omits/masks, UI shows “—” or hidden column.

**TC-06 – Reports row/col enforcement:**

- As member `GET /reports/deals-summary` – only own rows, sensitive cols masked. As admin all.
- Expected: Counts differ, CSV export same filtering.

**TC-07 – UI gating – hidden menus:**

- Login each role, check nav: Team visible only admin, Roles only admin, Export only manager+.
- Expected: Hidden, direct URL `/settings/team` as member -> 403 page or redirect.

**TC-08 – Create role happy path:**

- As admin `POST /roles {name:support, scopes:[tickets:read,tickets:write]}`.
- Expected: 201, assign to support user works.

**TC-09 – Update role scopes:**

- `PATCH /roles/support {scopes:add deals:read}` then as support `GET /deals` now 200 (was 403).
- Expected: Effective immediately (or after relogin – document).

**TC-10 – Delete role guard:**

- Delete custom unused -> 204. Delete assigned or system admin/manager -> 400 “Role in use / system”.
- Expected: Blocked with message.

**TC-11 – Validation – invalid scope/duplicate name:**

- `POST /roles {name:admin}` duplicate -> 409. `{scopes:[bogus:read]}` -> 400.
- Expected: No creation.

**TC-12 – Negative – privilege escalation via API:**

- As member `PATCH /users/me {role:admin}` or `PATCH /users/<self> {role:admin}`.
- Expected: 403/ignored, role unchanged. Verify `GET /users/me` still member.

**TC-13 – Negative – forge owner:**

- As member `POST /deals {title:Hack, owner_id:<adminId>}` or `PATCH /deals/<own> {owner_id:admin}`.
- Expected: Ignored/403, owner stays self. No cross-owner write.

**TC-14 – Negative – IDOR on users/deals:**

- As member `GET /users/<otherId>`, `GET /deals/<otherId>`.
- Expected: 403/404 (no leak – 404 preferred to avoid enumeration if spec says).

**TC-15 – Edge – role change mid-session:**

- Login member, admin changes them to viewer, member (same session) tries `POST /deals`.
- Expected: Now 403 (guard reads fresh DB) – verify no stale allow. Document if relogin required.

**TC-16 – Edge – last-admin demote via roles:**

- Try remove admin scope from admin role or demote last admin.
- Expected: Blocked 400.

**TC-17 – Persistence/reload:**

- Role change + reload UI – menus update without cache; logout/login retains; refresh reports still filtered.
- Expected: Consistent.

**TC-18 – Concurrency – parallel role updates:**

- Two admins PATCH same role different scopes simultaneously.
- Expected: One wins or merged, no corruption, version/etag if present else last-write-wins documented.

**TC-19 – Audit – perm denied + role changes logged:**

- Trigger 403s and role edits, check `GET /audit-logs`.
- Expected: `role.updated`, `access.denied` with actor, resource, required scope.

**TC-20 – Export enforcement:**

- As viewer `GET /reports/deals.csv` – should be 403 or masked CSV. As manager allowed but filtered.
- Expected: No full dump via export bypass.

**TC-21 – Search bypass check:**

- As member search `?search=Admin1` for admin’s deal.
- Expected: No results (search respects scope), not leaked via search.

**TC-22 – Empty/loading/error:**

- Role with zero perms logs in – dashboard shows empty states + “Contact admin”, not crash. Slow 3G matrix loads skeleton.

## 5. API Testing Section (endpoint table + at least 5 curl examples with expected status/body)

| Method | Path                   | Role                  | Success      | Fail                  |
| ------ | ---------------------- | --------------------- | ------------ | --------------------- |
| GET    | /roles                 | admin                 | 200          | 403 others            |
| POST   | /roles                 | admin                 | 201          | 400/409               |
| PATCH  | /roles/:id             | admin                 | 200          | 400 system            |
| GET    | /permissions/me        | any                   | 200 scopes   | 401 anon              |
| GET    | /users                 | admin (users:read)    | 200          | 403 member/viewer     |
| POST   | /deals                 | member+ (deals:write) | 201          | 403 viewer            |
| DELETE | /deals/:id             | owner/admin           | 204          | 403 non-owner         |
| GET    | /reports/deals-summary | manager+              | 200 filtered | 403 viewer if blocked |

**Curl 1 – Me perms:**

```bash
curl -i -b member_cookies.txt http://localhost:3001/permissions/me
# Expected: 200 {"role":"member","scopes":["deals:read","deals:write:own",...]}
curl -i -b viewer_cookies.txt http://localhost:3001/permissions/me
# Expected: 200 {"role":"viewer","scopes":["deals:read",...]}
```

**Curl 2 – Scope allow vs deny:**

```bash
curl -i -b viewer_cookies.txt -X POST http://localhost:3001/deals \
 -H "Content-Type: application/json" -d '{"title":"Try","value":100}'
# Expected: 403 {"message":"Forbidden: deals:write required"}
curl -i -b member_cookies.txt -X POST http://localhost:3001/deals \
 -H "Content-Type: application/json" -d '{"title":"M New","value":500}'
# Expected: 201
```

**Curl 3 – Record guard:**

```bash
curl -i -b member_cookies.txt http://localhost:3001/deals/<ADMIN_DEAL_ID>
# Expected: 403 or 404 (document)
curl -i -b admin_cookies.txt http://localhost:3001/deals/<ADMIN_DEAL_ID>
# Expected: 200 full fields
```

**Curl 4 – Roles CRUD:**

```bash
curl -i -b admin_cookies.txt -X POST http://localhost:3001/roles \
 -H "Content-Type: application/json" -d '{"name":"support","scopes":["tickets:read","tickets:write"]}'
# Expected: 201
curl -i -b member_cookies.txt http://localhost:3001/roles
# Expected: 403
```

**Curl 5 – Escalation blocked:**

```bash
curl -i -b member_cookies.txt -X PATCH http://localhost:3001/users/<MEMBER_ID> \
 -H "Content-Type: application/json" -d '{"role":"admin"}'
# Expected: 403 {"message":"Forbidden"}
```

**Curl 6 – Field mask:**

```bash
curl -i -b viewer_cookies.txt http://localhost:3001/deals/<ID>
# Expected: 200 without internalNotes/value or masked; admin has full
```

## 6. UI Testing Section (navigation path, assertions, empty/loading/error states, responsive, dark mode, keyboard/a11y)

**Navigation:** Login each role -> check nav/menus/buttons. `/settings/roles` as admin shows matrix; toggle scope -> Save -> toast. As member visit same URL -> 403 page. Deal row: member sees Edit on own, viewer sees none.
**Assertions:** Disabled buttons have tooltip “No permission”, hidden columns absent in DOM (not just CSS), Network shows 403 for blocked clicks, reports match API filtering.
**Empty:** Zero-perm role shows empty dashboard CTA; no deals for filter shows empty illustration.
**Loading:** Matrix skeleton on Slow 3G, Save spinner.
**Error:** 403 page has “Back to dashboard”, API down error card.
**Responsive:** Matrix scrolls horizontally on 375px with sticky role column, no overlap.
**Dark mode:** Badges/checkboxes contrast, disabled greys readable.
**Keyboard/a11y:** Checkboxes labelled, matrix keyboard toggle (Space), focus visible, aria-disabled, screen reader announces scope names.

## 7. Regression & Cross-Feature Impact

- Users: role assignment here affects team management; verify invite defaultRole respects new roles.
- Deals/Reports: any perm change must reflect in deals list and reports export – re-run those suites.
- SSO defaultRole must be valid role id/name – creating/deleting roles impacts SSO JIT.
- Audit: role edits logged; ensure old/new scopes diff stored.
- Org security: ssoOnly/2FA independent but admin-only to change – verify same guard.
- Deleting role in use must not orphan users – block or reassign.

## 8. Expected Results Summary Table

| TC    | Desc           | Expected             |
| ----- | -------------- | -------------------- |
| TC-01 | Admin all      | 200 all              |
| TC-02 | Manager team   | filtered             |
| TC-03 | Member own     | 403 others           |
| TC-04 | Viewer RO      | 403 writes           |
| TC-05 | Field mask     | hidden for viewer    |
| TC-06 | Reports filter | rows/cols filtered   |
| TC-07 | UI hidden      | 403 page direct      |
| TC-08 | Create role    | 201                  |
| TC-09 | Update scopes  | effective            |
| TC-10 | Delete guard   | 400 if in use/system |
| TC-11 | Invalid        | 400/409              |
| TC-12 | Escalation     | blocked              |
| TC-13 | Forge owner    | ignored/403          |
| TC-14 | IDOR           | 403/404 no leak      |
| TC-15 | Mid-session    | fresh check          |
| TC-16 | Last admin     | blocked              |
| TC-17 | Persist        | consistent           |
| TC-18 | Race           | no corrupt           |
| TC-19 | Audit          | logged               |
| TC-20 | Export         | filtered/403         |
| TC-21 | Search         | no leak              |
| TC-22 | Empty          | graceful             |

## 9. Troubleshooting & Common Failures

- **Member still sees admin deal:** Record guard missing on list (only detail guarded) – fix service filter, verify `where owner_id`.
- **Viewer can POST via curl but UI hidden:** Frontend-only gating – add backend guard, retest.
- **Sensitive field leaked in export/CSV:** Export bypasses DTO mask – apply same serializer.
- **Role change not effective until relogin:** JWT cached scopes – switch to DB lookup or shorten token TTL, document.
- **403 vs 404 confusion:** Decide: 403 for known-but-forbidden, 404 to hide existence for IDOR – align tests to spec.
- **Matrix save 400 invalid scope:** Typo `deals:Write` case – list canonical scopes from `GET /permissions/scopes`.
- **Last-admin lockout:** All admins demoted – recover via DB `UPDATE users SET role='admin'`.
- **Reports show all for member:** Report query missing owner filter – add, verify counts.

## 10. Pass/Fail Checklist (checkbox list)

- [ ] Admin full 200 (TC-01)
- [ ] Manager team filtered (TC-02)
- [ ] Member own-only, 403 others (TC-03)
- [ ] Viewer read-only (TC-04)
- [ ] Field masking verified API+UI (TC-05)
- [ ] Reports filtered rows/cols + CSV (TC-06)
- [ ] UI gating + 403 page (TC-07)
- [ ] Create role 201 (TC-08)
- [ ] Update scopes effective (TC-09)
- [ ] Delete guard (TC-10)
- [ ] Invalid 400/409 (TC-11)
- [ ] Escalation blocked (TC-12)
- [ ] Forge owner blocked (TC-13)
- [ ] IDOR no leak (TC-14)
- [ ] Mid-session fresh (TC-15)
- [ ] Last-admin blocked (TC-16)
- [ ] Persistence ok (TC-17)
- [ ] Race safe (TC-18)
- [ ] Audit logged (TC-19)
- [ ] Export enforced (TC-20)
- [ ] Search no leak (TC-21)
- [ ] Empty/loading ok (TC-22)
- [ ] Curls pass, responsive/dark/a11y pass
