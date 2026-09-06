import { Global, Module } from '@nestjs/common';
import { Pool } from 'pg';
import { APP_POOL, AUTH_POOL, IdentityDb, TenantDb } from './tenant-db.service';

function createPool(url: string | undefined, fallback: string): Pool {
  return new Pool({ connectionString: url || fallback, max: 10 });
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
