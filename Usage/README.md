# Nexus CRM — Feature Testing Guides (Usage/)

Comprehensive, step-by-step testing documentation for every Nexus CRM feature.
Each `<feature_name>.md` is a standalone, large testing playbook covering manual UI tests,
API tests (curl), RBAC/negative/edge cases, regression impact, and a pass/fail checklist.

## Global Test Setup (applies to all guides)

```sh
npm install
npm run infra:up        # postgres + mailpit (SMTP 1025, UI http://localhost:8025)
cp .env.example .env
# generate dev encryption key and put it in .env as FIELD_ENCRYPTION_KEY:
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npm run db:migrate
npm run queue:install -w @nexus/api   # one-time pg-boss schema setup
npm run dev:api         # API on http://localhost:3001
npm run dev:web         # Web on http://localhost:3000 (if applicable)
npm test                # full suite (requires infra up + migrations)
```

- **API base:** `http://localhost:3001`
- **Web base:** `http://localhost:3000`
- **Mailpit UI:** `http://localhost:8025`
- **Auth:** cookie session; pass `-b cookies.txt -c cookies.txt` in curl after `POST /auth/login`.
- **Roles to test:** Admin, Manager, Rep (limited), Read-only / suspended user.
- **Every guide structure:** Overview → Prerequisites → Environment Matrix → 18–25+ TC cases
  → API section → UI section → Regression → Results table → Troubleshooting → Checklist.

## Index

### Auth, Identity & Access

| File                                                             | Covers                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [auth-signup-login-sessions.md](./auth-signup-login-sessions.md) | Email signup/login/logout, cookie sessions, password reset, invites      |
| [two-factor-auth.md](./two-factor-auth.md)                       | TOTP setup/enable/verify/disable + backup codes                          |
| [sso.md](./sso.md)                                               | SAML/OIDC login flow + admin SSO configs, domains, default role          |
| [users-team-management.md](./users-team-management.md)           | CRUD users, invite list/get/accept, suspend, role assignment             |
| [roles-permissions.md](./roles-permissions.md)                   | RBAC roles/scopes, record-level + field-level perms (UI/API/reports)     |
| [org-workspace-settings.md](./org-workspace-settings.md)         | Org name/slug/plan, timezone/locale/currency, caps, stale-deal threshold |
| [security-settings.md](./security-settings.md)                   | 2FA policy, ssoOnly, passwordMinLength, session TTL                      |
| [audit-logs.md](./audit-logs.md)                                 | Who/what/old/new/IP/UA, 12-month retention purge                         |
| [privacy-gdpr.md](./privacy-gdpr.md)                             | GDPR export request/ready/download, redaction, 72h SLA                   |

### Contacts & Accounts Core

| File                                           | Covers                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| [contacts.md](./contacts.md)                   | Contact CRUD, lifecycleStage/tags/customFields, duplicate-email warning |
| [accounts.md](./accounts.md)                   | Account CRUD, parent-child hierarchy, domains/industry/owner/tags       |
| [contact-notes.md](./contact-notes.md)         | Per-contact notes (`/contacts/:contactId/notes`)                        |
| [activity-timeline.md](./activity-timeline.md) | Merged reverse-chron timeline                                           |
| [duplicates-merge.md](./duplicates-merge.md)   | Fuzzy candidates exact/high/medium, per-field merge, audit              |
| [imports-exports.md](./imports-exports.md)     | Async CSV import wizard (mapping/preview/dry-run/progress) + exports    |
| [custom-fields.md](./custom-fields.md)         | Custom fields/picklists/formulas/validation + layouts                   |

### Leads & Routing

| File                                       | Covers                                                        |
| ------------------------------------------ | ------------------------------------------------------------- |
| [leads.md](./leads.md)                     | Lead CRUD, status/source, UTM attribution, notes              |
| [lead-conversion.md](./lead-conversion.md) | Convert lead → contact + account (+deal)                      |
| [lead-routing.md](./lead-routing.md)       | Round-robin/manual rules, OOO, fallback queue, assignment log |
| [web-to-lead.md](./web-to-lead.md)         | Public form/embed snippet + capture endpoint                  |
| [territories.md](./territories.md)         | Rule-based territory matching + owner suggestion              |

### Pipeline, Deals & Quoting

| File                                               | Covers                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [pipelines.md](./pipelines.md)                     | Multiple pipelines, ordered stages, probability/closedWon/Lost                              |
| [deals-pipeline.md](./deals-pipeline.md)           | Deal CRUD, Kanban drag-drop, weighted value, forecast, win/loss, rot alerts, multi-currency |
| [competitors.md](./competitors.md)                 | Competitor catalog linked to deals                                                          |
| [products-line-items.md](./products-line-items.md) | Product catalog + deal line items (qty/discount/tax)                                        |
| [quotes.md](./quotes.md)                           | Quote snapshots, public token link, accept/decline                                          |
| [approvals.md](./approvals.md)                     | Generic approval requests (e.g. high-discount quote)                                        |

### Tasks, Activities, Scheduling & Email

| File                                             | Covers                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| [tasks.md](./tasks.md)                           | Tasks open/completed/cancelled, priority, reminders, digest, recurrence |
| [activities.md](./activities.md)                 | Unified log calls/meetings/emails/tasks + threading                     |
| [calendar-sync.md](./calendar-sync.md)           | Google/Outlook 2-way sync, conflict handling                            |
| [scheduling-booking.md](./scheduling-booking.md) | Booking links/slots + public booking                                    |
| [emails.md](./emails.md)                         | Email send/receive auto-logging, BCC dedup                              |
| [email-templates.md](./email-templates.md)       | Reusable `{{variable}}` templates                                       |
| [email-tracking.md](./email-tracking.md)         | Open/click tracking events (Apple MPP caveat)                           |
| [sequences.md](./sequences.md)                   | Cadences, enrollment pause/resume/cancel, reply auto-pause              |
| [sla-policies.md](./sla-policies.md)             | First-response/resolution SLA evaluation                                |

### Reporting & Collaboration

| File                                           | Covers                                                    |
| ---------------------------------------------- | --------------------------------------------------------- |
| [reports.md](./reports.md)                     | Forecast/pipeline/activity/conversion/cohort + CSV export |
| [dashboards.md](./dashboards.md)               | Customizable dashboards + widgets                         |
| [comments-mentions.md](./comments-mentions.md) | Internal comments with @mentions                          |
| [attachments-files.md](./attachments-files.md) | File attachments, 25MB/file + 10GB org caps               |

### Automation & Platform

| File                                                   | Covers                                                                |
| ------------------------------------------------------ | --------------------------------------------------------------------- |
| [workflows-automation.md](./workflows-automation.md)   | Trigger→condition→action builder, run log, loop protection            |
| [inbound-webhooks.md](./inbound-webhooks.md)           | HMAC inbound webhooks + API triggers                                  |
| [notifications.md](./notifications.md)                 | In-app/email/push routing, prefs center, digests, devices             |
| [billing-subscriptions.md](./billing-subscriptions.md) | Plans/seats prorated, immutable invoices                              |
| [onboarding.md](./onboarding.md)                       | Setup checklist, wizard, <10min TTFV                                  |
| [home-overview.md](./home-overview.md)                 | Home greeting, pipeline snapshot, Today's focus, quick actions        |
| [profile-settings.md](./profile-settings.md)           | User profile/timezone                                                 |
| [command-palette.md](./command-palette.md)             | Global Cmd+K navigation/search/quick actions                          |
| [inline-editing.md](./inline-editing.md)               | Click-to-edit optimistic UI + rollback                                |
| [app-shell-theming.md](./app-shell-theming.md)         | Sidebar, breadcrumbs, dark mode, skeletons, empty states, WCAG 2.1 AA |
| [api-platform.md](./api-platform.md)                   | Versioned REST, rate limits, health, queue workers, tenant isolation  |

## Suggested Testing Order

1. `onboarding.md` → `auth-signup-login-sessions.md` → `users-team-management.md` → `roles-permissions.md`
2. `org-workspace-settings.md` → `security-settings.md` → `sso.md` → `two-factor-auth.md`
3. `contacts.md` → `accounts.md` → `custom-fields.md` → `imports-exports.md` → `duplicates-merge.md`
4. `leads.md` → `web-to-lead.md` → `lead-routing.md` → `territories.md` → `lead-conversion.md`
5. `pipelines.md` → `deals-pipeline.md` → `products-line-items.md` → `quotes.md` → `approvals.md` → `competitors.md`
6. `tasks.md` → `activities.md` → `calendar-sync.md` → `scheduling-booking.md` → `emails.md` → `email-templates.md` → `email-tracking.md` → `sequences.md` → `sla-policies.md`
7. `comments-mentions.md` → `attachments-files.md` → `workflows-automation.md` → `inbound-webhooks.md` → `notifications.md`
8. `reports.md` → `dashboards.md` → `billing-subscriptions.md` → `privacy-gdpr.md` → `audit-logs.md`
9. Cross-cutting: `command-palette.md` → `inline-editing.md` → `app-shell-theming.md` → `api-platform.md` → `home-overview.md` → `profile-settings.md`
