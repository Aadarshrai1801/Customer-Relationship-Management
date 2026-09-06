import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AuditRetentionTasks } from './audit-retention.tasks';

@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService, AuditRetentionTasks],
  exports: [AuditService],
})
export class AuditModule {}
