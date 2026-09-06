import { Global, Module } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { QueueService } from './queue.service';
import { BOSS } from './queue.tokens';

export { BOSS };

@Global()
@Module({
  providers: [
    {
      provide: BOSS,
      useFactory: () => {
        const max = Number(process.env.DB_POOL_MAX ?? 10);
        return new PgBoss({
          connectionString:
            process.env.DATABASE_URL ?? 'postgres://nexus_app:nexus_app@localhost:5432/nexus',
          schema: 'boss',
          max: Number.isFinite(max) && max > 0 ? Math.floor(max) : 10,
        });
      },
    },
    QueueService,
  ],
  exports: [BOSS, QueueService],
})
export class QueueModule {}
