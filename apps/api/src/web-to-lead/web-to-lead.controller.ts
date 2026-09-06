import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../common/public.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireScopes } from '../rbac/require-scopes.decorator';
import {
  webToLeadInputSchema,
  type WebToLeadInput,
} from './web-to-lead.schemas';
import { WebToLeadService } from './web-to-lead.service';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller('web-to-lead')
export class WebToLeadController {
  constructor(
    @Inject(WebToLeadService)
    private readonly webToLeadService: WebToLeadService,
  ) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  async ingest(
    @Req() req: Request,
    @Body(new ZodValidationPipe(webToLeadInputSchema)) body: unknown,
    @Query('token') queryToken?: string,
  ): Promise<unknown> {
    const input = { ...(body as WebToLeadInput) };
    if (!input.token) {
      input.token =
        queryToken ||
        (req.headers['x-nexus-tenant-token'] as string) ||
        (req.headers['x-org-id'] as string);
    }

    const meta = {
      ip: req.ip || (req.headers['x-forwarded-for'] as string),
      userAgent: req.headers['user-agent'] as string,
      referer: req.headers['referer'] as string,
    };

    return this.webToLeadService.ingest(input, meta);
  }

  @RequireScopes('leads:manage')
  @Get('snippet')
  async getSnippet(@Req() req: Request): Promise<unknown> {
    const auth = authOf(req);
    const host = req.get('host') || 'localhost:3001';
    const protocol = req.protocol || 'http';
    const apiUrl = `${protocol}://${host}`;
    return this.webToLeadService.generateSnippet(auth.org, apiUrl);
  }
}
