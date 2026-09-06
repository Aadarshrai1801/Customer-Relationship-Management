import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { createReadStream } from 'node:fs';
import type { Request, Response } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { SESSION_COOKIE_NAME, clearedCookieOptions } from '../auth/tokens';
import { PrivacyService } from './privacy.service';
import { eraseSchema, type EraseInput } from './privacy.schemas';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller('privacy')
export class PrivacyController {
  constructor(@Inject(PrivacyService) private readonly privacy: PrivacyService) {}

  @Post('export')
  async requestExport(@Req() req: Request): Promise<unknown> {
    return this.privacy.requestExport(authOf(req));
  }

  @Get('exports')
  async listExports(@Req() req: Request): Promise<unknown> {
    return this.privacy.listExports(authOf(req));
  }

  @Get('export/:id/download')
  async download(
    @Req() req: Request,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.privacy.loadExportFile(authOf(req), id);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Content-Length', String(file.size));
    createReadStream(file.path).pipe(res);
  }

  @Post('erase')
  @HttpCode(HttpStatus.OK)
  async erase(
    @Req() req: Request,
    @Body(new ZodValidationPipe(eraseSchema)) body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const result = await this.privacy.requestErasure(authOf(req), (body as EraseInput).password);
    res.cookie(SESSION_COOKIE_NAME, '', clearedCookieOptions());
    return result;
  }
}
