import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { Public } from '../common/public.decorator';
import { RequireScopes } from '../rbac/require-scopes.decorator';
import { InboundService } from './inbound.service';
import { inboundEventSchema, type InboundEventInput } from './inbound.schemas';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

function signatureOf(req: Request): string | undefined {
  const header = req.headers['x-webhook-signature'];
  return Array.isArray(header) ? header[0] : header;
}

@Controller('inbound')
export class InboundController {
  constructor(@Inject(InboundService) private readonly inbound: InboundService) {}

  @Public()
  @Post(':source')
  @HttpCode(HttpStatus.OK)
  async ingest(
    @Param('source') source: string,
    @Body(new ZodValidationPipe(inboundEventSchema)) body: unknown,
    @Req() req: Request,
  ): Promise<unknown> {
    return this.inbound.ingest(
      source,
      JSON.stringify(body),
      signatureOf(req),
      body as InboundEventInput,
    );
  }

  @RequireScopes('org:manage')
  @Post('secret/rotate')
  async rotate(@Req() req: Request): Promise<unknown> {
    return this.inbound.rotateSecret(authOf(req).org.id);
  }
}
