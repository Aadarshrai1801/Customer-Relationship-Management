import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Job, PgBoss } from 'pg-boss';
import { BOSS } from './queue.tokens';

export type JobHandler<TData> = (job: Job<TData>) => Promise<unknown>;

interface WorkerRegistration<TData> {
  handler: JobHandler<TData>;
}

interface ScheduleRegistration {
  cron: string;
  data?: object;
}

/**
 * Thin wrapper over pg-boss. Workers and schedules are registered by feature
 * modules (privacy, audit); this service owns the Boss lifecycle and queue
 * creation. Disabled entirely when QUEUES_ENABLED=0 (tests).
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly workers = new Map<string, WorkerRegistration<unknown>>();
  private readonly schedules = new Map<string, ScheduleRegistration>();
  private started = false;

  constructor(@Inject(BOSS) private readonly boss: PgBoss) {}

  get enabled(): boolean {
    return process.env.QUEUES_ENABLED !== '0';
  }

  registerWorker<TData>(queue: string, handler: JobHandler<TData>): void {
    if (this.workers.has(queue)) {
      throw new Error(`Worker already registered for queue ${queue}`);
    }
    this.workers.set(queue, { handler: handler as JobHandler<unknown> });
    if (this.started) {
      void this.attachWorker(queue);
    }
  }

  registerSchedule(name: string, cron: string, data?: object): void {
    this.schedules.set(name, { cron, data });
    if (this.started) {
      void this.attachSchedule(name);
    }
  }

  async publish<TData extends object>(queue: string, data: TData): Promise<string | null> {
    if (!this.enabled) {
      throw new Error(`Cannot publish to ${queue}: queues are disabled (QUEUES_ENABLED=0)`);
    }
    await this.boss.createQueue(queue);
    return this.boss.send(queue, data);
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('Queues disabled (QUEUES_ENABLED=0) — workers and schedules inactive');
      return;
    }
    await this.boss.start();
    this.started = true;
    for (const queue of this.workers.keys()) {
      await this.attachWorker(queue);
    }
    for (const name of this.schedules.keys()) {
      await this.attachSchedule(name);
    }
    this.logger.log(
      `Queues started (${this.workers.size} workers, ${this.schedules.size} schedules)`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.started) {
      await this.boss.stop();
      this.started = false;
    }
  }

  private async attachWorker(queue: string): Promise<void> {
    const registration = this.workers.get(queue);
    if (!registration) return;
    await this.boss.createQueue(queue);
    await this.boss.work(queue, async (jobs) => {
      for (const job of jobs) {
        try {
          await registration.handler(job);
        } catch (err) {
          this.logger.error(`Job ${job.id} on ${queue} failed: ${(err as Error).message}`);
          throw err;
        }
      }
    });
  }

  private async attachSchedule(name: string): Promise<void> {
    const registration = this.schedules.get(name);
    if (!registration) return;
    await this.boss.createQueue(name);
    // schedule() upserts by name — safe across restarts and instances.
    await this.boss.schedule(name, registration.cron, registration.data ?? {});
  }
}
