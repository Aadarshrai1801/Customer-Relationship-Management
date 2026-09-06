import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from './audit.service';
import { QueueService } from '../queue/queue.service';

export const AUDIT_PURGE_QUEUE = 'audit-retention-purge';

/**
 * Schedules the audit retention purge (daily). The purge itself floors at the
 * 12-month PRD minimum regardless of configuration.
 */
@Injectable()
export class AuditRetentionTasks {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(QueueService) private readonly queues: QueueService,
  ) {}

  onModuleInit(): void {
    this.queues.registerWorker(AUDIT_PURGE_QUEUE, () => this.runRetentionPurge());
    this.queues.registerSchedule(AUDIT_PURGE_QUEUE, '0 3 * * *');
  }

  async runRetentionPurge(): Promise<{ deleted: number; retentionDays: number }> {
    const configured = Number(process.env.AUDIT_RETENTION_DAYS);
    return this.audit.purge(Number.isFinite(configured) ? configured : undefined);
  }
}
