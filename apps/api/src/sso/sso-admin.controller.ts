import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireScopes } from '../rbac/require-scopes.decorator';
import { SsoService } from './sso.service';
import {
  createSsoConfigSchema,
  updateSsoConfigSchema,
  type CreateSsoConfigInput,
  type UpdateSsoConfigInput,
} from './sso.schemas';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@RequireScopes('org:manage')
@Controller('sso/configs')
export class SsoAdminController {
  constructor(@Inject(SsoService) private readonly sso: SsoService) {}

  @Get()
  async list(@Req() req: Request): Promise<unknown> {
    return this.sso.listConfigs(authOf(req));
  }

  @Post()
  async create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(createSsoConfigSchema)) body: unknown,
  ): Promise<unknown> {
    return this.sso.createConfig(authOf(req), body as CreateSsoConfigInput);
  }

  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateSsoConfigSchema)) body: unknown,
  ): Promise<unknown> {
    return this.sso.updateConfig(authOf(req), id, body as UpdateSsoConfigInput);
  }

  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.sso.deleteConfig(authOf(req), id);
  }
}
