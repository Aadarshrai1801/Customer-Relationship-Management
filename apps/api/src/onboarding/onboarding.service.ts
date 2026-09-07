import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import {
  contacts,
  customFieldDefinitions,
  deals,
  dealStageHistory,
  emailTemplates,
  pipelines,
  users,
} from '@nexus/db';
import { TenantDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';

export interface OnboardingStep {
  key: string;
  label: string;
  description: string;
  done: boolean;
  link: string;
}

export interface OnboardingStatus {
  steps: OnboardingStep[];
  doneCount: number;
  total: number;
  complete: boolean;
}

/**
 * Module 9 (PRD 4.15): guided-setup checklist computed live from workspace
 * data — no extra state table to drift out of sync. Every step links to
 * the page that completes it; a fresh org finishes in minutes.
 */
@Injectable()
export class OnboardingService {
  constructor(@Inject(TenantDb) private readonly tenantDb: TenantDb) {}

  async status(auth: AuthContext): Promise<OnboardingStatus> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const [userRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .where(and(eq(users.orgId, auth.org.id), eq(users.status, 'active')));
      const teamDone = (userRow?.count ?? 0) > 1;

      const customPipes = await db
        .select({ id: pipelines.id })
        .from(pipelines)
        .where(and(eq(pipelines.orgId, auth.org.id), ne(pipelines.isDefault, true)))
        .limit(1);
      const [moveRow] = await db
        .select({ moves: sql<number>`count(*)::int` })
        .from(dealStageHistory)
        .where(
          and(
            eq(dealStageHistory.orgId, auth.org.id),
            sql`${dealStageHistory.fromStageId} IS NOT NULL`,
          ),
        );
      const pipelineDone = customPipes.length > 0 || (moveRow?.moves ?? 0) > 0;

      const [contactRow] = await db
        .select({ found: sql<number>`1` })
        .from(contacts)
        .where(and(eq(contacts.orgId, auth.org.id), isNull(contacts.deletedAt)))
        .limit(1);
      const [dealRow] = await db
        .select({ found: sql<number>`1` })
        .from(deals)
        .where(and(eq(deals.orgId, auth.org.id), isNull(deals.deletedAt)))
        .limit(1);
      const [fieldRow] = await db
        .select({ found: sql<number>`1` })
        .from(customFieldDefinitions)
        .where(eq(customFieldDefinitions.orgId, auth.org.id))
        .limit(1);
      const [templateRow] = await db
        .select({ found: sql<number>`1` })
        .from(emailTemplates)
        .where(and(eq(emailTemplates.orgId, auth.org.id), isNull(emailTemplates.deletedAt)))
        .limit(1);

      const steps: OnboardingStep[] = [
        {
          key: 'team',
          label: 'Invite your team',
          description: 'Workspaces work best with more than one seat.',
          done: teamDone,
          link: '/settings/users',
        },
        {
          key: 'pipeline',
          label: 'Work your pipeline',
          description: 'Move a deal between stages or add your own pipeline.',
          done: pipelineDone,
          link: '/deals',
        },
        {
          key: 'contact',
          label: 'Add your first contact',
          description: 'Import or create the people you sell to.',
          done: Boolean(contactRow),
          link: '/contacts',
        },
        {
          key: 'deal',
          label: 'Create your first deal',
          description: 'Deals open in the first stage of your pipeline.',
          done: Boolean(dealRow),
          link: '/deals',
        },
        {
          key: 'customize',
          label: 'Make it yours',
          description: 'Add a custom field or an email template.',
          done: Boolean(fieldRow) || Boolean(templateRow),
          link: '/settings/custom-fields',
        },
      ];
      const doneCount = steps.filter((s) => s.done).length;
      return { steps, doneCount, total: steps.length, complete: doneCount === steps.length };
    });
  }
}
