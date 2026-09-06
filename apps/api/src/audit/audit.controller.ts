import { Controller, Get, Inject, Query, Req, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';
import type { Request } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireScopes } from '../rbac/require-scopes.decorator';
import { AuditService } from './audit.service';

const listQuerySchema = z
  .object({
    entityType: z.string().trim().min(1).max(100).optional(),
    entityId: z.string().trim().min(1).max(100).optional(),
    actorUserId: z.string().trim().min(1).max(100).optional(),
    action: z.string().trim().min(1).max(100).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();

type ListQuery = z.infer<typeof listQuerySchema>;

@RequireScopes('audit:read')
@Controller('audit-log')
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @Get()
  async list(
    @Req() req: Request,
    @Query(new ZodValidationPipe(listQuerySchema)) query: unknown,
  ): Promise<unknown> {
    if (!req.auth) throw new UnauthorizedException();
    const q = query as ListQuery;
    return this.audit.list(req.auth.org.id, {
      entityType: q.entityType,
      entityId: q.entityId,
      actorUserId: q.actorUserId,
      action: q.action,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      limit: q.limit,
      cursor: q.cursor,
    });
  }
}
