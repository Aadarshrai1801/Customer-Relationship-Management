import { Global, Module } from '@nestjs/common';
import { Pool } from 'pg';
import { APP_POOL, AUTH_POOL, IdentityDb, TenantDb } from './tenant-db.service';

function createPool(url: string | undefined, fallback: string): Pool {
  // DB_POOL_MAX keeps parallel test workers under Postgres max_connections.
  const max = Number(process.env.DB_POOL_MAX ?? 10);
  return new Pool({
    connectionString: url || fallback,
    max: Number.isFinite(max) && max > 0 ? Math.floor(max) : 10,
  });
}

@Global()
@Module({
  providers: [
    {
      provide: APP_POOL,
      useFactory: () =>
        createPool(process.env.DATABASE_URL, 'postgres://nexus_app:nexus_app@localhost:5432/nexus'),
    },
    {
      provide: AUTH_POOL,
      useFactory: () =>
        createPool(
          process.env.AUTH_DATABASE_URL,
          'postgres://nexus_auth:nexus_auth@localhost:5432/nexus',
        ),
    },
    TenantDb,
    IdentityDb,
  ],
  exports: [APP_POOL, AUTH_POOL, TenantDb, IdentityDb],
})
export class DatabaseModule {}
