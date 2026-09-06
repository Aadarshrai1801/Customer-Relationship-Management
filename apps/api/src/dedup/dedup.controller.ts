import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
import { DedupService } from './dedup.service';

const listQuerySchema = z
  .object({
    entityType: z.enum(['contact', 'account']).optional(),
    confidence: z.enum(['exact', 'high', 'medium']).optional(),
    status: z.enum(['pending', 'dismissed', 'merged']).optional(),
  })
  .strict();

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller('duplicates')
export class DedupController {
  constructor(@Inject(DedupService) private readonly dedup: DedupService) {}

  // Scope is enforced per entity inside the service (contacts vs accounts).
  @Get()
  async list(
    @Req() req: Request,
    @Query(new ZodValidationPipe(listQuerySchema)) query: unknown,
  ): Promise<unknown> {
    const filter = query as {
      entityType?: 'contact' | 'account';
      confidence?: 'exact' | 'high' | 'medium';
      status?: 'pending' | 'dismissed' | 'merged';
    };
    return this.dedup.listCandidates(authOf(req), filter);
  }

  @Post(':id/dismiss')
  @HttpCode(HttpStatus.OK)
  async dismiss(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.dedup.dismissCandidate(authOf(req), id);
  }
}
