import { Controller, Get, Inject, Param, Query, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireScopes } from '../rbac/require-scopes.decorator';
import { TimelineService } from './timeline.service';

const timelineQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller('contacts/:contactId/timeline')
export class TimelineController {
  constructor(@Inject(TimelineService) private readonly timeline: TimelineService) {}

  @RequireScopes('contacts:read')
  @Get()
  async get(
    @Req() req: Request,
    @Param('contactId') contactId: string,
    @Query(new ZodValidationPipe(timelineQuerySchema)) query: unknown,
  ): Promise<unknown> {
    const { limit, cursor } = query as { limit?: number; cursor?: string };
    return this.timeline.getTimeline(authOf(req), contactId, { limit, cursor });
  }
}
