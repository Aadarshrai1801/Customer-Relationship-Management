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
      useFactory: () =>
        new PgBoss({
          connectionString:
            process.env.DATABASE_URL ?? 'postgres://nexus_app:nexus_app@localhost:5432/nexus',
          schema: 'boss',
        }),
    },
    QueueService,
  ],
  exports: [BOSS, QueueService],
})
export class QueueModule {}
