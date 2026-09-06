import { Controller, Get, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { Public } from '../common/public.decorator';
import { APP_POOL } from '../database/tenant-db.service';

@Controller('health')
export class HealthController {
  constructor(@Inject(APP_POOL) private readonly pool: Pool) {}

  @Public()
  @Get()
  async check(): Promise<{ status: string; database: string; timestamp: string }> {
    await this.pool.query('SELECT 1');
    return { status: 'ok', database: 'ok', timestamp: new Date().toISOString() };
  }
}
