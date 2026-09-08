import { Global, Module } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { QueueService } from './queue.service';
import { poolConfigFromUrl } from '../database/db-url';
import { BOSS } from './queue.tokens';

export { BOSS };

@Global()
@Module({
  providers: [
    {
      provide: BOSS,
      useFactory: () => {
        // pg-boss needs a direct (non-pooled) connection on Neon for
        // advisory locks. Prefer DIRECT_DATABASE_URL when set, otherwise
        // fall back to DATABASE_URL (fine for local Docker / single-node).
        const connectionString =
          process.env.DIRECT_DATABASE_URL ??
          process.env.DATABASE_URL ??
          'postgres://nexus_app:nexus_app@localhost:5432/nexus';
        const pool = poolConfigFromUrl(connectionString, connectionString);
        return new PgBoss({
          connectionString: pool.connectionString,
          ...(pool.ssl ? { ssl: pool.ssl as Record<string, unknown> } : {}),
          schema: 'boss',
          max: pool.max ?? 10,
        });
      },
    },
    QueueService,
  ],
  exports: [BOSS, QueueService],
})
export class QueueModule {}
