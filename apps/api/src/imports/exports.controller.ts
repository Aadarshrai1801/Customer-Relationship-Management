import {
  Controller,
  Get,
  Inject,
  Param,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireScopes } from '../rbac/require-scopes.decorator';
import { ExportsService } from './exports.service';

const exportQuerySchema = z
  .object({
    accountId: z.string().uuid().optional(),
    lifecycleStage: z.string().optional(),
  })
  .strict();

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller()
export class ExportsController {
  constructor(@Inject(ExportsService) private readonly exports: ExportsService) {}

  @RequireScopes('contacts:read')
  @Get('contacts-export')
  async exportContacts(
    @Req() req: Request,
    @Query(new ZodValidationPipe(exportQuerySchema)) query: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const filter = query as { accountId?: string; lifecycleStage?: string };
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    await this.exports.streamContactsCsv(authOf(req), filter, res);
  }

  @RequireScopes('accounts:read')
  @Get('accounts-export')
  async exportAccounts(@Req() req: Request, @Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="accounts-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    await this.exports.streamAccountsCsv(authOf(req), res);
  }

  @RequireScopes('contacts:read')
  @Get('contacts/:id/vcf')
  async exportVcf(
    @Req() req: Request,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { filename, body } = await this.exports.buildContactVcf(authOf(req), id);
    res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(body);
  }
}
