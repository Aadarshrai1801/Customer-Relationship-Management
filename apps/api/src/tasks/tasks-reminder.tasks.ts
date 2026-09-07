import { Inject, Injectable } from '@nestjs/common';
import { organizations } from '@nexus/db';
import { IdentityDb, TenantDb } from '../database/tenant-db.service';
import { QueueService } from '../queue/queue.service';
import { TasksService } from './tasks.service';

export const TASK_DIGEST_QUEUE = 'tasks-digest';

/**
 * Daily task-reminder digest (PRD 4.4: batch overdue/repeat alerts instead
 * of spamming). Runs every morning; orgs with nothing due are skipped.
 */
@Injectable()
export class TasksReminderTasks {
  constructor(
    @Inject(IdentityDb) private readonly identity: IdentityDb,
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(QueueService) private readonly queues: QueueService,
  ) {}

  onModuleInit(): void {
    this.queues.registerWorker(TASK_DIGEST_QUEUE, () => this.runDailyDigests());
    this.queues.registerSchedule(TASK_DIGEST_QUEUE, '0 8 * * *');
  }

  async runDailyDigests(
    now = new Date(),
  ): Promise<{ orgs: number; ownersNotified: number; tasksIncluded: number }> {
    const orgs = await this.identity.db.select({ id: organizations.id }).from(organizations);
    let ownersNotified = 0;
    let tasksIncluded = 0;
    for (const org of orgs) {
      const result = await this.tenantDb.tx(org.id, (db) =>
        this.tasks.dispatchDigestsForOrg(db, org.id, now),
      );
      ownersNotified += result.ownersNotified;
      tasksIncluded += result.tasksIncluded;
      await this.tasks.sendDigestEmails(org.id, result.emailTargets);
    }
    return { orgs: orgs.length, ownersNotified, tasksIncluded };
  }
}
