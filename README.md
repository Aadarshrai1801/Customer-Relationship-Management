# Nexus CRM

Monorepo for Nexus CRM. TypeScript full-stack, API-first.

## Prerequisites

- Node 22+
- Docker with Compose

## Setup

```sh
npm install
npm run infra:up        # postgres + mailpit
cp .env.example .env
# generate a dev encryption key and put it in .env as FIELD_ENCRYPTION_KEY:
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npm run db:migrate
npm run queue:install -w @nexus/api   # one-time pg-boss schema setup
npm run dev:api         # API on http://localhost:3001
```

## Scripts

| Command                                                     | Purpose                                                  |
| ----------------------------------------------------------- | -------------------------------------------------------- |
| `npm run infra:up` / `infra:down`                           | Start/stop Postgres + Mailpit (SMTP on 1025, UI on 8025) |
| `npm run db:migrate`                                        | Apply migrations (runs as superuser)                     |
| `npm run db:generate`                                       | Generate a migration from schema changes                 |
| `npm run dev:api`                                           | Run API in watch mode                                    |
| `npm test`                                                  | Run test suite (requires infra up + migrations applied)  |
| `npm run typecheck`, `npm run lint`, `npm run format:check` | Static checks                                            |
