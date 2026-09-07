import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireScopes } from '../rbac/require-scopes.decorator';
import { ApprovalsService } from './approvals.service';
import {
  decideApprovalSchema,
  requestApprovalSchema,
  type RequestApprovalInput,
} from './approvals.schemas';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

const listQuerySchema = z
  .object({ status: z.enum(['pending', 'approved', 'rejected']).optional() })
  .strict();

@Controller('approvals')
export class ApprovalsController {
  constructor(@Inject(ApprovalsService) private readonly approvals: ApprovalsService) {}

  @RequireScopes('deals:manage')
  @Post()
  async request(
    @Req() req: Request,
    @Body(new ZodValidationPipe(requestApprovalSchema)) body: unknown,
  ): Promise<unknown> {
    return this.approvals.request(authOf(req), body as RequestApprovalInput);
  }

  @RequireScopes('deals:read')
  @Get()
  async list(
    @Req() req: Request,
    @Query(new ZodValidationPipe(listQuerySchema)) query: unknown,
  ): Promise<unknown> {
    // Listing is reviewer-gated in-service (users:manage); the route
    // scope only ensures a signed-in CRM user.
    return this.approvals.list(authOf(req), query as { status?: 'pending' | 'approved' | 'rejected' });
  }

  @RequireScopes('deals:read')
  @Post(':id/approve')
  async approve(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(decideApprovalSchema)) body: unknown,
  ): Promise<unknown> {
    return this.approvals.decide(authOf(req), id, 'approved', (body as { reason?: string }).reason);
  }

  @RequireScopes('deals:read')
  @Post(':id/reject')
  async reject(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(decideApprovalSchema)) body: unknown,
  ): Promise<unknown> {
    return this.approvals.decide(authOf(req), id, 'rejected', (body as { reason?: string }).reason);
  }
}
