import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { users, workflowRuns, workflows, type Workflow } from '@nexus/db';
import { TenantDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { AuditService } from '../audit/audit.service';
import type { CreateWorkflowInput, UpdateWorkflowInput } from './workflows.schemas';

export interface SerializedWorkflow {
  id: string;
  owner: { id: string; name: string } | null;
  ownerId: string | null;
  name: string;
  isActive: boolean;
  trigger: Record<string, unknown>;
  conditions: Array<Record<string, unknown>>;
  actions: Array<Record<string, unknown>>;
  maxRuns: number;
  createdAt: Date;
  updatedAt: Date;
}

function parseCursor(cursor: string): { time: Date; id: string } | null {
  const sep = cursor.lastIndexOf('|');
  if (sep < 0) return null;
  const time = new Date(cursor.slice(0, sep));
  const id = cursor.slice(sep + 1);
  if (Number.isNaN(time.getTime()) || !id) return null;
  return { time, id };
}

// Workflow visibility is enforced by the workflows:read/manage route
// scopes (reps and viewers hold neither, since actions may embed webhook
// secrets). No per-record check applies to org-level automation config.

@Injectable()
export class WorkflowsService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(
    auth: AuthContext,
    input: CreateWorkflowInput,
  ): Promise<{ workflow: SerializedWorkflow }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const [created] = await db
        .insert(workflows)
        .values({
          orgId: auth.org.id,
          ownerId: auth.user.id,
          name: input.name,
          isActive: input.isActive,
          trigger: input.trigger as Record<string, unknown>,
          conditions: input.conditions as Array<Record<string, unknown>>,
          actions: input.actions as Array<Record<string, unknown>>,
          maxRuns: input.maxRuns,
        })
        .returning();
      if (!created) throw new Error('Workflow insert returned no row');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'workflow.created',
        entityType: 'workflow',
        entityId: created.id,
        newValues: { name: created.name, trigger: created.trigger },
      });
      return { workflow: await this.serializeById(db, auth, created.id) };
    });
  }

  async list(
    auth: AuthContext,
    query: { limit?: number; cursor?: string },
  ): Promise<{ workflows: SerializedWorkflow[]; nextCursor: string | null }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const conditions = [eq(workflows.orgId, auth.org.id), isNull(workflows.deletedAt)];
      if (query.cursor) {
        const parsed = parseCursor(query.cursor);
        if (!parsed) {
          throw new BadRequestException({
            message: 'Invalid pagination cursor',
            code: 'INVALID_CURSOR',
          });
        }
        conditions.push(
          sql`(${workflows.createdAt}, ${workflows.id}) < (${parsed.time}, ${parsed.id}::uuid)`,
        );
      }
      const rows = await db
        .select({ workflow: workflows, owner: users })
        .from(workflows)
        .leftJoin(users, eq(workflows.ownerId, users.id))
        .where(and(...conditions))
        .orderBy(desc(workflows.createdAt), desc(workflows.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        workflows: page.map((row) => this.serialize(row.workflow, row.owner)),
        nextCursor:
          rows.length > limit && last
            ? `${last.workflow.createdAt.toISOString()}|${last.workflow.id}`
            : null,
      };
    });
  }

  async getById(auth: AuthContext, id: string): Promise<SerializedWorkflow> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      return this.serializeById(db, auth, id);
    });
  }

  async update(
    auth: AuthContext,
    id: string,
    patch: UpdateWorkflowInput,
  ): Promise<{ workflow: SerializedWorkflow }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.requireLiveWorkflow(db, auth.org.id, id);
      const [updated] = await db
        .update(workflows)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
          ...(patch.trigger !== undefined
            ? { trigger: patch.trigger as Record<string, unknown> }
            : {}),
          ...(patch.conditions !== undefined
            ? { conditions: patch.conditions as Array<Record<string, unknown>> }
            : {}),
          ...(patch.actions !== undefined
            ? { actions: patch.actions as Array<Record<string, unknown>> }
            : {}),
          ...(patch.maxRuns !== undefined ? { maxRuns: patch.maxRuns } : {}),
          updatedAt: new Date(),
        })
        .where(eq(workflows.id, row.id))
        .returning();
      if (!updated) throw new Error('Workflow update returned no row');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'workflow.updated',
        entityType: 'workflow',
        entityId: updated.id,
        oldValues: { name: row.name, isActive: row.isActive },
        newValues: { name: updated.name, isActive: updated.isActive },
      });
      return { workflow: await this.serializeById(db, auth, updated.id) };
    });
  }

  async remove(auth: AuthContext, id: string): Promise<{ ok: true }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.requireLiveWorkflow(db, auth.org.id, id);
      await db.update(workflows).set({ deletedAt: new Date() }).where(eq(workflows.id, row.id));
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'workflow.deleted',
        entityType: 'workflow',
        entityId: row.id,
        oldValues: { name: row.name },
      });
      return { ok: true as const };
    });
  }

  async listRuns(
    auth: AuthContext,
    workflowId: string,
    query: { status?: 'success' | 'failed' | 'skipped'; limit?: number; cursor?: string },
  ): Promise<{ runs: unknown[]; nextCursor: string | null }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      await this.requireLiveWorkflow(db, auth.org.id, workflowId);
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const conditions = [
        eq(workflowRuns.orgId, auth.org.id),
        eq(workflowRuns.workflowId, workflowId),
      ];
      if (query.status) conditions.push(eq(workflowRuns.status, query.status));
      if (query.cursor) {
        const parsed = parseCursor(query.cursor);
        if (!parsed) {
          throw new BadRequestException({
            message: 'Invalid pagination cursor',
            code: 'INVALID_CURSOR',
          });
        }
        conditions.push(
          sql`(${workflowRuns.createdAt}, ${workflowRuns.id}) < (${parsed.time}, ${parsed.id}::uuid)`,
        );
      }
      const rows = await db
        .select()
        .from(workflowRuns)
        .where(and(...conditions))
        .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        runs: page,
        nextCursor:
          rows.length > limit && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
      };
    });
  }

  private async requireLiveWorkflow(db: NexusDb, orgId: string, id: string): Promise<Workflow> {
    const [row] = await db
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, id), eq(workflows.orgId, orgId), isNull(workflows.deletedAt)));
    if (!row) {
      throw new NotFoundException({ message: 'Workflow not found', code: 'WORKFLOW_NOT_FOUND' });
    }
    return row;
  }

  private async serializeById(
    db: NexusDb,
    auth: AuthContext,
    id: string,
  ): Promise<SerializedWorkflow> {
    const [row] = await db
      .select({ workflow: workflows, owner: users })
      .from(workflows)
      .leftJoin(users, eq(workflows.ownerId, users.id))
      .where(
        and(eq(workflows.id, id), eq(workflows.orgId, auth.org.id), isNull(workflows.deletedAt)),
      );
    if (!row) {
      throw new NotFoundException({ message: 'Workflow not found', code: 'WORKFLOW_NOT_FOUND' });
    }
    return this.serialize(row.workflow, row.owner);
  }

  private serialize(
    workflow: Workflow,
    owner: { id: string; name: string } | null,
  ): SerializedWorkflow {
    return {
      id: workflow.id,
      owner: owner ? { id: owner.id, name: owner.name } : null,
      ownerId: workflow.ownerId,
      name: workflow.name,
      isActive: workflow.isActive,
      trigger: (workflow.trigger ?? {}) as Record<string, unknown>,
      conditions: (workflow.conditions ?? []) as Array<Record<string, unknown>>,
      actions: (workflow.actions ?? []) as Array<Record<string, unknown>>,
      maxRuns: workflow.maxRuns,
      createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt,
    };
  }
}
