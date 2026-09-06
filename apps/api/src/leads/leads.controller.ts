import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
  convertLeadSchema,
  createLeadSchema,
  listLeadsQuerySchema,
  updateLeadSchema,
  type ConvertLeadInput,
  type CreateLeadInput,
  type ListLeadsQuery,
  type UpdateLeadInput,
} from './leads.schemas';
import {
  reassignLeadSchema,
  type ReassignLeadInput,
} from '../lead-routing/lead-routing.schemas';
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

  @RequireScopes('leads:manage')
  @Post(':id/reassign')
  @HttpCode(HttpStatus.OK)
  async reassign(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reassignLeadSchema)) body: unknown,
  ): Promise<unknown> {
    return this.leads.reassign(authOf(req), id, body as ReassignLeadInput);
  }

  @RequireScopes('leads:read')
  @Get(':id/assignment-history')
  async assignmentHistory(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.leads.getAssignmentHistory(authOf(req), id);
  }

  @RequireScopes('leads:manage')
  @Post(':id/convert')
  @HttpCode(HttpStatus.OK)
  async convert(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(convertLeadSchema)) body: unknown,
  ): Promise<unknown> {
    return this.leads.convert(authOf(req), id, (body ?? {}) as ConvertLeadInput);
  }
}

