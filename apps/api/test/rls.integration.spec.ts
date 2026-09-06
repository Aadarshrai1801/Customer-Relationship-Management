import { randomBytes } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import {
  organizations,
  roles,
  sessions,
  users,
  type NewOrganization,
  type NewRole,
  type NewUser,
} from '@nexus/db';
import { TenantDb, IdentityDb } from '../src/database/tenant-db.service';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://nexus_app:nexus_app@localhost:5432/nexus';
const AUTH_DATABASE_URL =
  process.env.AUTH_DATABASE_URL ?? 'postgres://nexus_auth:nexus_auth@localhost:5432/nexus';

function rlsMessage(err: unknown): string {
  const e = err as Error & { cause?: unknown };
  const cause = e.cause instanceof Error ? e.cause.message : String(e.cause ?? '');
  return `${e.message} ${cause}`;
}

describe('tenant isolation (row-level security at the database layer)', () => {
  const runId = randomBytes(4).toString('hex');
  const emailA = `a-${runId}@acme.test`;
  const emailB = `b-${runId}@globex.test`;
  const sessionTokenB = `rls-session-b-${runId}`;

  let appPool: Pool;
  let authPool: Pool;
  let tenantDb: TenantDb;
  let identityDb: IdentityDb;
  let orgAId: string;
  let orgBId: string;
  let roleAId: string;
  let roleBId: string;
  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
    appPool = new Pool({ connectionString: DATABASE_URL });
    authPool = new Pool({ connectionString: AUTH_DATABASE_URL });
    tenantDb = new TenantDb(appPool);
    identityDb = new IdentityDb(authPool);

    const orgA: NewOrganization = { name: 'Acme', slug: `acme-rls-${runId}` };
    const orgB: NewOrganization = { name: 'Globex', slug: `globex-rls-${runId}` };
    const [createdA] = await identityDb.db.insert(organizations).values(orgA).returning();
    const [createdB] = await identityDb.db.insert(organizations).values(orgB).returning();
    orgAId = createdA!.id;
    orgBId = createdB!.id;

    const roleA: NewRole = { orgId: orgAId, key: 'owner', name: 'Owner', isSystem: true };
    const roleB: NewRole = { orgId: orgBId, key: 'owner', name: 'Owner', isSystem: true };
    const [ra, rb] = await identityDb.db.insert(roles).values([roleA, roleB]).returning();
    roleAId = ra!.id;
    roleBId = rb!.id;

    const userA: NewUser = { orgId: orgAId, email: emailA, name: 'A', roleId: roleAId };
    const userB: NewUser = { orgId: orgBId, email: emailB, name: 'B', roleId: roleBId };
    const createdUsers = await identityDb.db.insert(users).values([userA, userB]).returning();
    userAId = createdUsers.find((u) => u.orgId === orgAId)!.id;
    userBId = createdUsers.find((u) => u.orgId === orgBId)!.id;
  });

  afterAll(async () => {
    await identityDb.db.delete(organizations).where(eq(organizations.id, orgAId));
    await identityDb.db.delete(organizations).where(eq(organizations.id, orgBId));
    await appPool.end();
    await authPool.end();
  });

  it('reads own tenant rows inside the tenant transaction context', async () => {
    const rows = await tenantDb.tx(orgAId, (db) =>
      db.select().from(users).where(eq(users.id, userAId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe(emailA);
  });

  it('returns zero rows when the tenant context differs (cross-tenant read blocked by RLS)', async () => {
    const rows = await tenantDb.tx(orgAId, (db) =>
      db.select().from(users).where(eq(users.id, userBId)),
    );
    expect(rows).toHaveLength(0);
  });

  it('returns zero rows with no tenant context at all', async () => {
    const result = await appPool.query('SELECT * FROM users');
    expect(result.rowCount).toBe(0);
  });

  it('rejects INSERT whose org_id does not match the tenant context (WITH CHECK)', async () => {
    let caught: unknown;
    try {
      await tenantDb.tx(orgAId, (db) =>
        db.insert(users).values({
          orgId: orgBId,
          email: `sneaky-${runId}@acme.test`,
          name: 'Sneaky',
          roleId: roleAId,
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(rlsMessage(caught)).toMatch(/row-level security/i);
  });

  it('DELETE of another tenant row affects zero rows (USING filter) and the row survives', async () => {
    const deleted = await tenantDb.tx(orgAId, (db) =>
      db.delete(users).where(eq(users.id, userBId)),
    );
    expect(deleted.rowCount).toBe(0);
    const stillThere = await identityDb.db.select().from(users).where(eq(users.id, userBId));
    expect(stillThere).toHaveLength(1);
  });

  it('sessions and roles are equally tenant-isolated', async () => {
    await identityDb.db.insert(sessions).values({
      orgId: orgBId,
      userId: userBId,
      tokenHash: sessionTokenB,
      expiresAt: new Date(),
    });
    const visible = await tenantDb.tx(orgAId, (db) => db.select().from(sessions));
    expect(visible).toHaveLength(0);
    const roleRows = await tenantDb.tx(orgAId, (db) => db.select().from(roles));
    expect(roleRows.map((r) => r.id)).toEqual([roleAId]);
    const foreignRole = await tenantDb.tx(orgBId, (db) =>
      db.select().from(roles).where(eq(roles.id, roleBId)),
    );
    expect(foreignRole).toHaveLength(1);
  });

  it('identity pool (BYPASSRLS) can resolve a user by email across tenants, for login bootstrap', async () => {
    const found = await identityDb.db.select().from(users).where(eq(users.email, emailA));
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe(userAId);
  });
});
