import { Global, Module } from '@nestjs/common';
import { Pool } from 'pg';
import { APP_POOL, AUTH_POOL, IdentityDb, TenantDb } from './tenant-db.service';
import { poolConfigFromUrl } from './db-url';

function createPool(url: string | undefined, fallback: string): Pool {
  // DB_POOL_MAX keeps parallel test workers under Postgres max_connections.
  // On Neon free tier / serverless keep this low (e.g. DB_POOL_MAX=5).
  return new Pool(poolConfigFromUrl(url, fallback));
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
