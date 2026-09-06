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
import { RolesService } from './roles.service';
import {
  createRoleSchema,
  updateRoleSchema,
  type CreateRoleInput,
  type UpdateRoleInput,
} from './roles.schemas';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller('roles')
export class RolesController {
  constructor(@Inject(RolesService) private readonly roles: RolesService) {}

  @RequireScopes('roles:read')
  @Get()
  async list(@Req() req: Request): Promise<unknown> {
    return this.roles.list(authOf(req));
  }

  @RequireScopes('roles:manage')
  @Post()
  async create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(createRoleSchema)) body: unknown,
  ): Promise<unknown> {
    return this.roles.create(authOf(req), body as CreateRoleInput);
  }

  @RequireScopes('roles:manage')
  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateRoleSchema)) body: unknown,
  ): Promise<unknown> {
    return this.roles.update(authOf(req), id, body as UpdateRoleInput);
  }

  @RequireScopes('roles:manage')
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.roles.remove(authOf(req), id);
  }
}
