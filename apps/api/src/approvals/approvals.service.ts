import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { approvals, notifications, roles, users, type Approval } from '@nexus/db';
import { TenantDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { AuditService } from '../audit/audit.service';
import { hasScope } from '../rbac/permissions';
import type { RequestApprovalInput } from './approvals.schemas';

export interface SerializedApproval {
  id: string;
  requester: { id: string; name: string } | null;
  decidedBy: { id: string; name: string } | null;
  entityType: string;
  entityId: string;
  action: string;
  payload: Record<string, unknown>;
  status: string;
  reason: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function recordForbidden(): never {
  throw new ForbiddenException({
    message: 'Not allowed to access this record',
    code: 'RECORD_FORBIDDEN',
  });
}

@Injectable()
export class ApprovalsService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * Approvers are users:manage holders (managers of the workspace).
   * Requesters cannot approve their own requests.
   */
  async request(auth: AuthContext, input: RequestApprovalInput): Promise<{ approval: SerializedApproval }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const [open] = await db
        .select({ id: approvals.id })
        .from(approvals)
        .where(
          and(
            eq(approvals.orgId, auth.org.id),
            eq(approvals.entityType, input.entityType),
            eq(approvals.entityId, input.entityId),
            eq(approvals.action, input.action),
            eq(approvals.status, 'pending'),
          ),
        );
      if (open) {
        throw new ConflictException({
          message: 'A pending approval already exists for this item',
          code: 'APPROVAL_PENDING',
        });
      }
      const [created] = await db
        .insert(approvals)
        .values({
          orgId: auth.org.id,
          requesterId: auth.user.id,
          entityType: input.entityType,
          entityId: input.entityId,
          action: input.action,
          payload: input.payload,
          status: 'pending',
        })
        .returning();
      if (!created) throw new Error('Approval insert returned no row');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'approval.requested',
        entityType: input.entityType,
        entityId: input.entityId,
        newValues: { approvalId: created.id, action: input.action },
      });
      await this.notifyApprovers(db, auth, created);
      return { approval: await this.serializeById(db, auth, created.id) };
    });
  }

  async list(
    auth: AuthContext,
    query: { status?: 'pending' | 'approved' | 'rejected' },
  ): Promise<SerializedApproval[]> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      this.assertCanReview(auth);
      const rows = await db
        .select({ approval: approvals })
        .from(approvals)
        .where(
          and(
            eq(approvals.orgId, auth.org.id),
            ...(query.status ? [eq(approvals.status, query.status)] : []),
          ),
        )
        .orderBy(desc(approvals.createdAt));
      return Promise.all(rows.map((row) => this.serialize(db, row.approval)));
    });
  }

  async decide(
    auth: AuthContext,
    id: string,
    decision: 'approved' | 'rejected',
    reason?: string,
  ): Promise<{ approval: SerializedApproval }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      this.assertCanReview(auth);
      const [row] = await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.id, id), eq(approvals.orgId, auth.org.id)));
      if (!row) {
        throw new NotFoundException({ message: 'Approval not found', code: 'APPROVAL_NOT_FOUND' });
      }
      if (row.status !== 'pending') {
        throw new ConflictException({ message: 'Approval already decided', code: 'APPROVAL_DECIDED' });
      }
      if (row.requesterId === auth.user.id) {
        throw new ForbiddenException({
          message: 'Requesters cannot approve their own requests',
          code: 'SELF_APPROVAL',
        });
      }
      const [updated] = await db
        .update(approvals)
        .set({ status: decision, decidedById: auth.user.id, reason: reason ?? null, decidedAt: new Date(), updatedAt: new Date() })
        .where(eq(approvals.id, row.id))
        .returning();
      if (!updated) throw new Error('Approval decision returned no row');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: `approval.${decision}`,
        entityType: row.entityType,
        entityId: row.entityId,
        newValues: { approvalId: row.id, reason: reason ?? null },
      });
      return { approval: await this.serializeById(db, auth, updated.id) };
    });
  }

  /** Enforcement hook: approved quote_discount approval for this quote? */
  async hasApprovedDiscount(db: NexusDb, orgId: string, quoteId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          eq(approvals.orgId, orgId),
          eq(approvals.entityType, 'quote'),
          eq(approvals.entityId, quoteId),
          eq(approvals.action, 'quote_discount'),
          eq(approvals.status, 'approved'),
        ),
      );
    return Boolean(row);
  }

  private assertCanReview(auth: AuthContext): void {
    if (!hasScope(auth.role.permissions, 'users:manage')) {
      recordForbidden();
    }
  }

  private async notifyApprovers(db: NexusDb, auth: AuthContext, approval: Approval): Promise<void> {
    // Owner/admin role holders review approvals; everyone else lacks users:manage.
    const approvers = await db
      .select({ id: users.id })
      .from(users)
      .innerJoin(roles, eq(users.roleId, roles.id))
      .where(
        and(
          eq(users.orgId, auth.org.id),
          eq(users.status, 'active'),
          sql`${roles.key} IN ('owner', 'admin')`,
        ),
      );
    for (const approver of approvers) {
      if (approver.id === auth.user.id) continue;
      await db.insert(notifications).values({
        orgId: auth.org.id,
        userId: approver.id,
        type: 'approval_requested',
        title: `${auth.user.name} requested approval`,
        body: `${approval.action} on ${approval.entityType}`,
        link: '/settings/approvals',
      });
    }
    await this.audit.record(db, {
      orgId: auth.org.id,
      actorUserId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'approval.review_requested',
      entityType: approval.entityType,
      entityId: approval.entityId,
      newValues: { approvalId: approval.id },
    });
  }

  private async requireLiveApproval(db: NexusDb, orgId: string, id: string): Promise<Approval> {
    const [row] = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, id), eq(approvals.orgId, orgId)));
    if (!row) {
      throw new NotFoundException({ message: 'Approval not found', code: 'APPROVAL_NOT_FOUND' });
    }
    return row;
  }

  private async serializeById(db: NexusDb, _auth: AuthContext, id: string): Promise<SerializedApproval> {
    const row = await this.requireLiveApproval(db, _auth.org.id, id);
    return this.serialize(db, row);
  }

  private async serialize(db: NexusDb, approval: Approval): Promise<SerializedApproval> {
    const [requester] = approval.requesterId
      ? await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, approval.requesterId))
      : [undefined];
    const [decidedBy] = approval.decidedById
      ? await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, approval.decidedById))
      : [undefined];
    return {
      id: approval.id,
      requester: requester ?? null,
      decidedBy: decidedBy ?? null,
      entityType: approval.entityType,
      entityId: approval.entityId,
      action: approval.action,
      payload: (approval.payload ?? {}) as Record<string, unknown>,
      status: approval.status,
      reason: approval.reason,
      decidedAt: approval.decidedAt,
      createdAt: approval.createdAt,
      updatedAt: approval.updatedAt,
    };
  }
}
