import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
import { UsersService } from './users.service';
import {
  changeRoleSchema,
  updateUserSchema,
  type ChangeRoleInput,
  type UpdateUserInput,
} from './users.schemas';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller('users')
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @RequireScopes('users:read')
  @Get()
  async list(@Req() req: Request): Promise<unknown> {
    return this.users.list(authOf(req));
  }

  @RequireScopes('users:read')
  @Get(':id')
  async getById(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.users.getById(authOf(req), id);
  }

  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateUserSchema)) body: unknown,
  ): Promise<unknown> {
    return this.users.update(authOf(req), id, body as UpdateUserInput);
  }

  @RequireScopes('users:manage')
  @Patch(':id/role')
  async changeRole(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(changeRoleSchema)) body: unknown,
  ): Promise<unknown> {
    return this.users.changeRole(authOf(req), id, body as ChangeRoleInput);
  }

  @RequireScopes('users:manage')
  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  async suspend(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.users.setStatus(authOf(req), id, 'suspended');
  }

  @RequireScopes('users:manage')
  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  async activate(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.users.setStatus(authOf(req), id, 'active');
  }
}
