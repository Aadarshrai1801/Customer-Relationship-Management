import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';

export const APP_POOL = Symbol('APP_POOL');
export const AUTH_POOL = Symbol('AUTH_POOL');

export type NexusDb = NodePgDatabase;

@Injectable()
export class TenantDb {
  constructor(@Inject(APP_POOL) private readonly pool: Pool) {}

  async tx<T>(orgId: string, fn: (db: NexusDb) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [orgId]);
      const db = drizzle(client);
      const result = await fn(db);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

@Injectable()
export class IdentityDb {
  constructor(@Inject(AUTH_POOL) private readonly pool: Pool) {}

  get db(): NexusDb {
    return drizzle(this.pool);
  }
}
