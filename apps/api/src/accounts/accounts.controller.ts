import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireScopes } from '../rbac/require-scopes.decorator';
import { AccountsService } from './accounts.service';
import {
  createAccountSchema,
  listAccountsQuerySchema,
  updateAccountSchema,
  type CreateAccountInput,
  type ListAccountsQuery,
  type UpdateAccountInput,
} from './accounts.schemas';
import {
  mergeBodySchema,
  mergePreviewQuerySchema,
  type MergeBody,
  type MergePreviewQuery,
} from '../common/merge.schemas';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller('accounts')
export class AccountsController {
  constructor(@Inject(AccountsService) private readonly accounts: AccountsService) {}

  @RequireScopes('accounts:manage')
  @Post()
  async create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(createAccountSchema)) body: unknown,
  ): Promise<unknown> {
    return this.accounts.create(authOf(req), body as CreateAccountInput);
  }

  @RequireScopes('accounts:read')
  @Get()
  async list(
    @Req() req: Request,
    @Query(new ZodValidationPipe(listAccountsQuerySchema)) query: unknown,
  ): Promise<unknown> {
    return this.accounts.list(authOf(req), query as ListAccountsQuery);
  }

  @RequireScopes('accounts:read')
  @Get(':id')
  async getById(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.accounts.getById(authOf(req), id);
  }

  @RequireScopes('accounts:manage')
  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateAccountSchema)) body: unknown,
  ): Promise<unknown> {
    return this.accounts.update(authOf(req), id, body as UpdateAccountInput);
  }

  @RequireScopes('accounts:manage')
  @Get(':id/merge-preview')
  async mergePreview(
    @Req() req: Request,
    @Param('id') id: string,
    @Query(new ZodValidationPipe(mergePreviewQuerySchema)) query: unknown,
  ): Promise<unknown> {
    const { loserId } = query as MergePreviewQuery;
    return this.accounts.mergePreview(authOf(req), id, loserId);
  }

  @RequireScopes('accounts:manage')
  @Post(':id/merge')
  async merge(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(mergeBodySchema)) body: unknown,
  ): Promise<unknown> {
    const { loserId, fieldChoices } = body as MergeBody;
    return this.accounts.mergeAccounts(authOf(req), id, loserId, fieldChoices);
  }

  @RequireScopes('accounts:manage')
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.accounts.remove(authOf(req), id);
  }
}
