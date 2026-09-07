import { Body, Controller, Get, Inject, Patch, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireScopes } from '../rbac/require-scopes.decorator';
import { OrgService } from './org.service';
import {
  updateSecuritySchema,
  updateSettingsSchema,
  type UpdateSecurityInput,
  type UpdateSettingsInput,
} from './org.schemas';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller('org')
export class OrgController {
  constructor(@Inject(OrgService) private readonly org: OrgService) {}

  @RequireScopes('org:read')
  @Get()
  async get(@Req() req: Request): Promise<unknown> {
    return this.org.get(authOf(req));
  }

  @RequireScopes('org:manage')
  @Patch('security')
  async updateSecurity(
    @Req() req: Request,
    @Body(new ZodValidationPipe(updateSecuritySchema)) body: unknown,
  ): Promise<unknown> {
    return this.org.updateSecurity(authOf(req), body as UpdateSecurityInput);
  }

  @RequireScopes('org:manage')
  @Patch('settings')
  async updateSettings(
    @Req() req: Request,
    @Body(new ZodValidationPipe(updateSettingsSchema)) body: unknown,
  ): Promise<unknown> {
    return this.org.updateSettings(authOf(req), body as UpdateSettingsInput);
  }
}
