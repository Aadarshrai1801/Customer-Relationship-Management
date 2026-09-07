import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import {
  activities,
  contacts,
  emailTemplates,
  sequenceEnrollments,
  sequences,
  users,
  type Sequence,
} from '@nexus/db';
import { IdentityDb, TenantDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { AuditService } from '../audit/audit.service';
import { ContactsService } from '../contacts/contacts.service';
import { MailService } from '../mail/mail.service';
import { QueueService } from '../queue/queue.service';
import { renderTemplateText } from '../emails/tracking-tokens';
import type { CreateSequenceInput, SequenceStep, UpdateSequenceInput } from './sequences.schemas';

export const SEQUENCES_DUE_QUEUE = 'sequences-due';

export interface SerializedSequence {
  id: string;
  owner: { id: string; name: string } | null;
  name: string;
  isActive: boolean;
  steps: Array<Record<string, unknown>>;
  enrolled: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SerializedEnrollment {
  id: string;
  sequenceId: string;
  contact: { id: string; name: string; email: string } | null;
  owner: { id: string; name: string } | null;
  status: string;
  currentStep: number;
  nextRunAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class SequencesService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(IdentityDb) private readonly identity: IdentityDb,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(QueueService) private readonly queues: QueueService,
  ) {}

  onModuleInit(): void {
    this.queues.registerWorker(SEQUENCES_DUE_QUEUE, () => this.runDue());
    this.queues.registerSchedule(SEQUENCES_DUE_QUEUE, '0 9 * * *');
  }

  async create(
    auth: AuthContext,
    input: CreateSequenceInput,
  ): Promise<{ sequence: SerializedSequence }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      this.assertSendSteps(input.steps);
      const [created] = await db
        .insert(sequences)
        .values({
          orgId: auth.org.id,
          ownerId: auth.user.id,
          name: input.name,
          isActive: input.isActive,
          steps: input.steps as Array<Record<string, unknown>>,
        })
        .returning();
      if (!created) throw new Error('Sequence insert returned no row');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'sequence.created',
        entityType: 'sequence',
        entityId: created.id,
        newValues: { name: created.name, steps: input.steps.length },
      });
      return { sequence: await this.serializeById(db, auth, created.id) };
    });
  }

  async list(auth: AuthContext): Promise<SerializedSequence[]> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const rows = await db
        .select({ sequence: sequences, owner: users })
        .from(sequences)
        .leftJoin(users, eq(sequences.ownerId, users.id))
        .where(and(eq(sequences.orgId, auth.org.id), isNull(sequences.deletedAt)))
        .orderBy(desc(sequences.createdAt));
      return Promise.all(rows.map((row) => this.serialize(row.sequence, row.owner, db)));
    });
  }

  async getById(auth: AuthContext, id: string): Promise<SerializedSequence> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      return this.serializeById(db, auth, id);
    });
  }

  async update(
    auth: AuthContext,
    id: string,
    patch: UpdateSequenceInput,
  ): Promise<{ sequence: SerializedSequence }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.requireLiveSequence(db, auth.org.id, id);
      if (patch.steps) this.assertSendSteps(patch.steps);
      const [updated] = await db
        .update(sequences)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
          ...(patch.steps !== undefined
            ? { steps: patch.steps as Array<Record<string, unknown>> }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(sequences.id, row.id))
        .returning();
      if (!updated) throw new Error('Sequence update returned no row');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'sequence.updated',
        entityType: 'sequence',
        entityId: updated.id,
        newValues: { name: updated.name, isActive: updated.isActive },
      });
      return { sequence: await this.serializeById(db, auth, updated.id) };
    });
  }

  async remove(auth: AuthContext, id: string): Promise<{ ok: true }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.requireLiveSequence(db, auth.org.id, id);
      await db.update(sequences).set({ deletedAt: new Date() }).where(eq(sequences.id, row.id));
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'sequence.deleted',
        entityType: 'sequence',
        entityId: row.id,
        oldValues: { name: row.name },
      });
      return { ok: true as const };
    });
  }

  async enroll(
    auth: AuthContext,
    sequenceId: string,
    contactId: string,
  ): Promise<{ enrollment: SerializedEnrollment }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const sequence = await this.requireLiveSequence(db, auth.org.id, sequenceId);
      const contact = await this.contacts.requireLiveContact(db, auth.org.id, contactId);
      this.contacts.assertContactReadable(auth, contact.contact.ownerId);
      const [existing] = await db
        .select({ id: sequenceEnrollments.id })
        .from(sequenceEnrollments)
        .where(
          and(
            eq(sequenceEnrollments.orgId, auth.org.id),
            eq(sequenceEnrollments.sequenceId, sequence.id),
            eq(sequenceEnrollments.contactId, contact.contact.id),
            eq(sequenceEnrollments.status, 'active'),
          ),
        );
      if (existing) {
        throw new BadRequestException({
          message: 'Contact is already enrolled in this sequence',
          code: 'ALREADY_ENROLLED',
        });
      }
      const [created] = await db
        .insert(sequenceEnrollments)
        .values({
          orgId: auth.org.id,
          sequenceId: sequence.id,
          contactId: contact.contact.id,
          ownerId: auth.user.id,
          status: 'active',
          currentStep: 0,
          nextRunAt: new Date(),
        })
        .returning();
      if (!created) throw new Error('Enrollment insert returned no row');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'sequence.enrolled',
        entityType: 'sequence',
        entityId: sequence.id,
        newValues: { contactId: contact.contact.id },
      });
      return { enrollment: await this.serializeEnrollment(db, created.id, auth.org.id) };
    });
  }

  async listEnrollments(auth: AuthContext, sequenceId: string): Promise<SerializedEnrollment[]> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      await this.requireLiveSequence(db, auth.org.id, sequenceId);
      const rows = await db
        .select({ enrollment: sequenceEnrollments })
        .from(sequenceEnrollments)
        .where(
          and(
            eq(sequenceEnrollments.orgId, auth.org.id),
            eq(sequenceEnrollments.sequenceId, sequenceId),
          ),
        )
        .orderBy(desc(sequenceEnrollments.createdAt));
      return Promise.all(
        rows.map((row) => this.serializeEnrollment(db, row.enrollment.id, auth.org.id)),
      );
    });
  }

  async pauseEnrollment(
    auth: AuthContext,
    enrollmentId: string,
  ): Promise<{ enrollment: SerializedEnrollment }> {
    return this.setEnrollmentStatus(auth, enrollmentId, 'paused');
  }

  async resumeEnrollment(
    auth: AuthContext,
    enrollmentId: string,
  ): Promise<{ enrollment: SerializedEnrollment }> {
    return this.setEnrollmentStatus(auth, enrollmentId, 'active');
  }

  async cancelEnrollment(
    auth: AuthContext,
    enrollmentId: string,
  ): Promise<{ enrollment: SerializedEnrollment }> {
    return this.setEnrollmentStatus(auth, enrollmentId, 'canceled');
  }

  /**
   * Reply auto-pause (PRD 4.5 edge): a detected reply stops the cadence
   * for that contact across the org's sequences.
   */
  async pauseForReply(orgId: string, contactId: string): Promise<number> {
    return this.tenantDb.tx(orgId, async (db) => {
      const rows = await db
        .select({ id: sequenceEnrollments.id })
        .from(sequenceEnrollments)
        .where(
          and(
            eq(sequenceEnrollments.orgId, orgId),
            eq(sequenceEnrollments.contactId, contactId),
            eq(sequenceEnrollments.status, 'active'),
          ),
        );
      for (const row of rows) {
        await db
          .update(sequenceEnrollments)
          .set({ status: 'paused', updatedAt: new Date() })
          .where(eq(sequenceEnrollments.id, row.id));
        await this.audit.record(db, {
          orgId,
          actorUserId: null,
          actorEmail: null,
          action: 'sequence.auto_paused',
          entityType: 'sequence',
          entityId: row.id,
          newValues: { reason: 'reply_detected', contactId },
        });
      }
      return rows.length;
    });
  }

  /**
   * Daily worker: advances due enrollments one step per run. Wait steps
   * push nextRunAt forward; send steps deliver immediately. Exhausted
   * enrollments complete; failures pause the enrollment with the error
   * recorded (visible, retryable via resume).
   */
  async runDue(): Promise<{ advanced: number; failed: number }> {
    const orgs = await this.identity.db
      .select({ id: users.orgId })
      .from(users)
      .then((rows) => [...new Set(rows.map((r) => r.id))]);
    let advanced = 0;
    let failed = 0;
    for (const orgId of orgs) {
      try {
        const result = await this.tenantDb.tx(orgId, (db) => this.runDueForOrg(db, orgId));
        advanced += result.advanced;
        failed += result.failed;
      } catch {
        failed += 1;
      }
    }
    return { advanced, failed };
  }

  private async runDueForOrg(
    db: NexusDb,
    orgId: string,
  ): Promise<{ advanced: number; failed: number }> {
    const due = await db
      .select({ enrollment: sequenceEnrollments, sequence: sequences })
      .from(sequenceEnrollments)
      .innerJoin(sequences, eq(sequenceEnrollments.sequenceId, sequences.id))
      .where(
        and(
          eq(sequenceEnrollments.orgId, orgId),
          eq(sequenceEnrollments.status, 'active'),
          lte(sequenceEnrollments.nextRunAt, new Date()),
          eq(sequences.isActive, true),
          isNull(sequences.deletedAt),
        ),
      )
      .limit(100);
    let advanced = 0;
    let failed = 0;
    for (const row of due) {
      try {
        await this.advanceEnrollment(db, orgId, row.enrollment.id);
        advanced += 1;
      } catch (err) {
        // Park the enrollment so one bad step cannot spin forever;
        // resume re-arms it after a fix.
        await this.setStatus(db, orgId, row.enrollment.id, 'paused');
        await this.audit.record(db, {
          orgId,
          actorUserId: null,
          actorEmail: null,
          action: 'sequence.enrollment_paused',
          entityType: 'sequence',
          entityId: row.enrollment.sequenceId,
          newValues: {
            enrollmentId: row.enrollment.id,
            error: err instanceof Error ? err.message : String(err),
          },
        });
        failed += 1;
      }
    }
    return { advanced, failed };
  }

  private async advanceEnrollment(db: NexusDb, orgId: string, enrollmentId: string): Promise<void> {
    const [row] = await db
      .select({ enrollment: sequenceEnrollments, sequence: sequences })
      .from(sequenceEnrollments)
      .innerJoin(sequences, eq(sequenceEnrollments.sequenceId, sequences.id))
      .where(
        and(
          eq(sequenceEnrollments.id, enrollmentId),
          eq(sequenceEnrollments.orgId, orgId),
          eq(sequenceEnrollments.status, 'active'),
        ),
      );
    if (!row) return;
    const steps = (row.sequence.steps ?? []) as SequenceStep[];
    const step = steps[row.enrollment.currentStep];
    if (!step) {
      await this.setStatus(db, orgId, row.enrollment.id, 'completed');
      return;
    }
    if (step.kind === 'wait') {
      await db
        .update(sequenceEnrollments)
        .set({
          currentStep: row.enrollment.currentStep + 1,
          nextRunAt: new Date(Date.now() + step.days * 86400000),
          updatedAt: new Date(),
        })
        .where(eq(sequenceEnrollments.id, row.enrollment.id));
      return;
    }
    await this.sendSequenceEmail(db, orgId, row.enrollment, step);
    const done = row.enrollment.currentStep + 1 >= steps.length;
    await db
      .update(sequenceEnrollments)
      .set({
        currentStep: row.enrollment.currentStep + 1,
        status: done ? 'completed' : 'active',
        nextRunAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(sequenceEnrollments.id, row.enrollment.id));
  }

  private async sendSequenceEmail(
    db: NexusDb,
    orgId: string,
    enrollment: typeof sequenceEnrollments.$inferSelect,
    step: Extract<SequenceStep, { kind: 'send_email' }>,
  ): Promise<void> {
    const [contact] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, enrollment.contactId), eq(contacts.orgId, orgId)));
    if (!contact || contact.deletedAt) throw new Error('Enrolled contact is gone');
    let subject = step.subject ?? '';
    let body = step.body ?? '';
    if (step.templateId) {
      const [template] = await db
        .select()
        .from(emailTemplates)
        .where(
          and(
            eq(emailTemplates.id, step.templateId),
            eq(emailTemplates.orgId, orgId),
            isNull(emailTemplates.deletedAt),
          ),
        );
      if (!template) throw new Error('Sequence template is gone');
      subject = template.subject;
      body = template.body;
    }
    if (!subject.trim() || !body.trim())
      throw new Error('Sequence email step needs a subject and body');
    const [owner] = enrollment.ownerId
      ? await db.select().from(users).where(eq(users.id, enrollment.ownerId))
      : [undefined];
    const variables: Record<string, unknown> = {
      contactName: contact.name,
      contactEmail: contact.email,
      ownerName: owner?.name ?? '',
      ...(step.variables as Record<string, unknown> | undefined),
    };
    const renderedSubject = renderTemplateText(subject, variables);
    const renderedBody = renderTemplateText(body, variables);
    const transactionId = await this.mail.sendEmail({
      to: contact.email,
      subject: renderedSubject,
      text: renderedBody,
    });
    await db.insert(activities).values({
      orgId,
      ownerId: enrollment.ownerId,
      contactId: contact.id,
      accountId: contact.accountId,
      type: 'email',
      subject: renderedSubject,
      body: renderedBody,
      occurredAt: new Date(),
      direction: 'outbound',
      senderEmail: owner?.email?.toLowerCase() ?? null,
      recipientEmails: [contact.email.toLowerCase()],
      provider: 'nexus-sequence',
      externalId: transactionId,
    });
    await this.audit.record(db, {
      orgId,
      actorUserId: enrollment.ownerId,
      actorEmail: owner?.email ?? null,
      action: 'email.sent',
      entityType: 'sequence',
      entityId: enrollment.sequenceId,
      newValues: { to: contact.email, enrollmentId: enrollment.id },
    });
  }

  private async setEnrollmentStatus(
    auth: AuthContext,
    enrollmentId: string,
    status: 'paused' | 'active' | 'canceled',
  ): Promise<{ enrollment: SerializedEnrollment }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const [row] = await db
        .select()
        .from(sequenceEnrollments)
        .where(
          and(eq(sequenceEnrollments.id, enrollmentId), eq(sequenceEnrollments.orgId, auth.org.id)),
        );
      if (!row) {
        throw new NotFoundException({
          message: 'Enrollment not found',
          code: 'ENROLLMENT_NOT_FOUND',
        });
      }
      await this.setStatus(db, auth.org.id, row.id, status);
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'sequence.enrollment_updated',
        entityType: 'sequence',
        entityId: row.sequenceId,
        newValues: { enrollmentId: row.id, status },
      });
      return { enrollment: await this.serializeEnrollment(db, row.id, auth.org.id) };
    });
  }

  private async setStatus(
    db: NexusDb,
    orgId: string,
    enrollmentId: string,
    status: string,
  ): Promise<void> {
    await db
      .update(sequenceEnrollments)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(sequenceEnrollments.id, enrollmentId), eq(sequenceEnrollments.orgId, orgId)));
  }

  private assertSendSteps(steps: SequenceStep[]): void {
    for (const step of steps) {
      if (
        step.kind === 'send_email' &&
        !step.templateId &&
        (!step.subject?.trim() || !step.body?.trim())
      ) {
        throw new BadRequestException({
          message: 'Email steps need a template or a subject and body',
          code: 'INVALID_SEQUENCE_STEP',
        });
      }
    }
  }

  private async requireLiveSequence(db: NexusDb, orgId: string, id: string): Promise<Sequence> {
    const [row] = await db
      .select()
      .from(sequences)
      .where(and(eq(sequences.id, id), eq(sequences.orgId, orgId), isNull(sequences.deletedAt)));
    if (!row) {
      throw new NotFoundException({ message: 'Sequence not found', code: 'SEQUENCE_NOT_FOUND' });
    }
    return row;
  }

  private async serializeById(
    db: NexusDb,
    auth: AuthContext,
    id: string,
  ): Promise<SerializedSequence> {
    const [row] = await db
      .select({ sequence: sequences, owner: users })
      .from(sequences)
      .leftJoin(users, eq(sequences.ownerId, users.id))
      .where(
        and(eq(sequences.id, id), eq(sequences.orgId, auth.org.id), isNull(sequences.deletedAt)),
      );
    if (!row) {
      throw new NotFoundException({ message: 'Sequence not found', code: 'SEQUENCE_NOT_FOUND' });
    }
    return this.serialize(row.sequence, row.owner, db);
  }

  private async serialize(
    sequence: Sequence,
    owner: { id: string; name: string } | null,
    db: NexusDb,
  ): Promise<SerializedSequence> {
    const countRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(sequenceEnrollments)
      .where(
        and(
          eq(sequenceEnrollments.sequenceId, sequence.id),
          eq(sequenceEnrollments.status, 'active'),
        ),
      );
    return {
      id: sequence.id,
      owner: owner ? { id: owner.id, name: owner.name } : null,
      name: sequence.name,
      isActive: sequence.isActive,
      steps: (sequence.steps ?? []) as Array<Record<string, unknown>>,
      enrolled: countRows[0]?.count ?? 0,
      createdAt: sequence.createdAt,
      updatedAt: sequence.updatedAt,
    };
  }

  private async serializeEnrollment(
    db: NexusDb,
    enrollmentId: string,
    orgId: string,
  ): Promise<SerializedEnrollment> {
    const [row] = await db
      .select({ enrollment: sequenceEnrollments, owner: users })
      .from(sequenceEnrollments)
      .leftJoin(users, eq(sequenceEnrollments.ownerId, users.id))
      .where(and(eq(sequenceEnrollments.id, enrollmentId), eq(sequenceEnrollments.orgId, orgId)));
    if (!row) {
      throw new NotFoundException({
        message: 'Enrollment not found',
        code: 'ENROLLMENT_NOT_FOUND',
      });
    }
    const [contact] = await db
      .select({ id: contacts.id, name: contacts.name, email: contacts.email })
      .from(contacts)
      .where(eq(contacts.id, row.enrollment.contactId));
    return {
      id: row.enrollment.id,
      sequenceId: row.enrollment.sequenceId,
      contact: contact ?? null,
      owner: row.owner ? { id: row.owner.id, name: row.owner.name } : null,
      status: row.enrollment.status,
      currentStep: row.enrollment.currentStep,
      nextRunAt: row.enrollment.nextRunAt,
      createdAt: row.enrollment.createdAt,
      updatedAt: row.enrollment.updatedAt,
    };
  }
}
