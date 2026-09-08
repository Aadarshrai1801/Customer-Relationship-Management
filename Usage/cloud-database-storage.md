# Going Fully Online — Neon Postgres + Cloudflare R2 + Hosted Email

This guide explains how Nexus CRM stores data online instead of local Docker
volumes, and gives exact steps to switch. Companion to
[README.md](./README.md).

## 1. Overview

| Data                       | Local default (dev)              | Online (production)                        | Code ref                                                            |
| -------------------------- | -------------------------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| All CRM records (Postgres) | `docker-compose` postgres:16     | Neon serverless Postgres                   | `apps/api/src/database/database.module.ts`, `db-url.ts`             |
| Job queue (pg-boss)        | Same local Postgres (`boss`)     | Same Neon DB (needs **direct** URL)        | `apps/api/src/queue/queue.module.ts`                                |
| Attachments                | `STORAGE_DIR/attachments/…` disk | Cloudflare R2 bucket (`attachments/…`)     | `apps/api/src/storage/storage.service.ts`, `attachments.service.ts` |
| GDPR export files          | `STORAGE_DIR/exports/…` disk     | Same R2 bucket (`exports/…`)               | `privacy.service.ts`                                                |
| CSV import staging files   | `STORAGE_DIR/imports/…` disk     | Same R2 bucket (`imports/…`)               | `imports.service.ts`                                                |
| Outbound email             | Mailpit (`SMTP_URL`, local-only) | Resend / SendGrid / Brevo / Gmail via SMTP | `apps/api/src/mail/mail.service.ts`                                 |

### Why Neon (Postgres) and NOT MongoDB

MongoDB was considered and rejected for this codebase:

1. The entire data layer (`packages/db/src/schema.ts`, ~all services) is
   relational: contacts→accounts, deals→pipelines/stages, line items,
   RBAC joins, `lower(email) IN (…)` dedup queries. A document DB would need
   a full rewrite of every query.
2. Drizzle ORM here uses the `postgresql` dialect; MongoDB would mean a new
   ODM plus re-implemented transactions.
3. `pg-boss` (job queue for imports, GDPR exports, digests) **only runs on
   Postgres**. Moving to MongoDB would also force a new queue system.
4. Neon keeps **zero code changes** for queries: you only swap the connection
   string, and TLS is auto-negotiated by `db-url.ts`.

### Why Cloudflare R2 (and not D1 / KV) for files

- D1 is SQLite-based and KV is key/value with size limits — neither fits the
  relational data model, so the database stays on Neon Postgres.
- R2 is S3-compatible object storage, ideal for attachments/exports/imports,
  with no egress fees. The new `StorageService` (`STORAGE_DRIVER=s3`) speaks
  S3, so R2, AWS S3, or any S3-compatible backend works.

## 2. Prerequisites

- A Neon account (free tier is enough to start): https://neon.tech
- A Cloudflare account with R2 enabled (for files)
- An SMTP sender: Resend (simplest), SendGrid, Brevo, or Gmail app password
- Node 22+, `npm install` done, `@aws-sdk/client-s3` installed (already in
  `apps/api/package.json` — needed only when `STORAGE_DRIVER=s3`)

## 3. Step-by-step: database → Neon

1. Neon dashboard → **Create project** (region closest to your API hosting;
   e.g. AWS ap-south-1 for India). Note the **pooled** and **direct** URLs.
2. Copy to `.env` (see `.env.example` for the full block):
   `DATABASE_URL=<pooled>?sslmode=require`,
   `AUTH_DATABASE_URL=<same pooled URL>`,
   `MIGRATE_DATABASE_URL=<direct URL>`,
   `DIRECT_DATABASE_URL=<direct URL>`, `DB_POOL_MAX=5`.
3. Run migrations against Neon: `npm run db:migrate`.
4. One-time queue schema: `npm run queue:install -w @nexus/api`.
5. Boot: `npm run dev:api`, then sign up via the web app and confirm records
   appear in Neon's **Tables** browser.
6. Keep local Docker for development if you like — switching is just env vars;
   nothing else changes.

## 4. Step-by-step: files → Cloudflare R2

1. Cloudflare dashboard → **R2** → **Create bucket** (e.g. `nexus-storage`).
2. R2 → **Manage API tokens** → token with **Object Read & Write** on that
   bucket. Save the access key, secret, and endpoint
   (`https://<account-id>.r2.cloudflarestorage.com`).
3. Set in `.env`:
   `STORAGE_DRIVER=s3`, `S3_ENDPOINT=…`, `S3_REGION=auto`,
   `S3_BUCKET=nexus-storage`, `S3_ACCESS_KEY_ID=…`, `S3_SECRET_ACCESS_KEY=…`.
4. Restart the API. Existing DB rows keep their `storageKey`s; the same
   relative keys (`attachments/…`, `exports/…`, `imports/…`) now live in R2.
   (Migrating old local files: upload `storage/attachments/*`,
   `storage/exports/*`, `storage/imports/*` to the same prefixes in R2.)
5. Smoke test: upload an attachment, download it back, request a GDPR export
   and download it, run a small CSV import end-to-end.

## 5. Step-by-step: email → hosted SMTP

`MailService` already accepts any `SMTP_URL`, so this is config-only:

1. Pick a provider and create an API key / SMTP credential.
2. Set `SMTP_URL` (examples in `.env.example`) and
   `MAIL_FROM=Nexus CRM <noreply@yourdomain.com>` (must be a verified sender
   on most providers, otherwise mail is rejected or spam-foldered).
3. Set `WEB_ORIGIN=https://<your-web-app>` and `API_URL=https://<your-api>`
   so invite / reset / tracking links point at production.
4. Smoke test: sign up a second user (invite email), request a password reset,
   trigger a lead assignment notification.

## 6. How to verify everything is online

- [ ] `docker compose down` locally — the API still boots and serves data
- [ ] `GET /v1/health` returns ok with Docker stopped
- [ ] New contact/deal created in UI appears in Neon Tables browser
- [ ] Attachment upload → object appears in R2 under `attachments/<orgId>/…`
- [ ] GDPR export download works; object under `exports/…` in R2
- [ ] CSV import validate → commit completes; worker logs show pg-boss jobs
      running against Neon
- [ ] Invite + password-reset emails arrive from the hosted sender
- [ ] Audit log captures the above actions (proves single source of truth)

## 7. Troubleshooting

| Symptom                                      | Likely cause / fix                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| `SSL required` / `ECONNRESET` on boot        | Old URL without `?sslmode=require`; re-copy from Neon, or set `DATABASE_SSL=true`  |
| `password authentication failed`             | Pooled vs direct URL mix-up, or special chars in password not URL-encoded          |
| `too many clients` on Neon free tier         | Lower `DB_POOL_MAX` (5), ensure one API replica during tests                       |
| pg-boss `stuck` / jobs never run             | `DIRECT_DATABASE_URL` missing — set Neon's direct URL; run `queue:install` once    |
| `S3 storage misconfigured` on boot with `s3` | Missing `S3_ENDPOINT`/`S3_BUCKET`/keys; compare with `.env.example` block          |
| R2 `AccessDenied` on upload                  | Token scoped to wrong bucket, or `S3_FORCE_PATH_STYLE` wrongly set to true         |
| Attachments 404 after switching to R2        | Old files still on local disk — backfill them to the same R2 prefixes              |
| Emails silently missing                      | `MAIL_FROM` domain unverified, or provider credentials wrong — check provider logs |
| Tests fail with cloud env active             | Integration tests expect local Docker; run them with the local `.env` values       |

## 8. Reverting to local

Unset `STORAGE_DRIVER` (defaults to `local`), restore the three local
`postgres://…@localhost:5433/nexus` URLs, `SMTP_URL=smtp://localhost:1025`,
and `npm run infra:up`. No code changes needed either way.
