import { loadEnv } from './src/env';
import { defineConfig } from 'drizzle-kit';

loadEnv();

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.MIGRATE_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/nexus',
  },
});
