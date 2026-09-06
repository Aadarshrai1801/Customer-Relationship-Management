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
import {
  createLeadSchema,
  listLeadsQuerySchema,
  updateLeadSchema,
  type CreateLeadInput,
  type ListLeadsQuery,
  type UpdateLeadInput,
} from './leads.schemas';
import { LeadsService } from './leads.service';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller('leads')
export class LeadsController {
  constructor(@Inject(LeadsService) private readonly leads: LeadsService) {}

  @RequireScopes('leads:manage')
  @Post()
  async create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(createLeadSchema)) body: unknown,
  ): Promise<unknown> {
    return this.leads.create(authOf(req), body as CreateLeadInput);
  }

  @RequireScopes('leads:read')
  @Get()
  async list(
    @Req() req: Request,
    @Query(new ZodValidationPipe(listLeadsQuerySchema)) query: unknown,
  ): Promise<unknown> {
    return this.leads.list(authOf(req), query as ListLeadsQuery);
  }

  @RequireScopes('leads:read')
  @Get(':id')
  async get(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.leads.get(authOf(req), id);
  }

  @RequireScopes('leads:manage')
  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateLeadSchema)) body: unknown,
  ): Promise<unknown> {
    return this.leads.update(authOf(req), id, body as UpdateLeadInput);
  }

  @RequireScopes('leads:manage')
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.leads.remove(authOf(req), id);
  }
}
