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
import { EmailsService } from './emails.service';
import {
  convertSuggestionSchema,
  createTemplateSchema,
  sendEmailSchema,
  suggestionsQuerySchema,
  syncInboundSchema,
  updateTemplateSchema,
  type ConvertSuggestionInput,
  type CreateTemplateInput,
  type SendEmailInput,
  type SuggestionsQuery,
  type SyncInboundInput,
  type UpdateTemplateInput,
} from './emails.schemas';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller('emails')
export class EmailsController {
  constructor(@Inject(EmailsService) private readonly emails: EmailsService) {}

  @RequireScopes('activities:manage')
  @Post('sync')
  async syncInbound(
    @Req() req: Request,
    @Body(new ZodValidationPipe(syncInboundSchema)) body: unknown,
  ): Promise<unknown> {
    return this.emails.syncInbound(authOf(req), body as SyncInboundInput);
  }

  @RequireScopes('activities:read')
  @Get('suggestions')
  async suggestions(
    @Req() req: Request,
    @Query(new ZodValidationPipe(suggestionsQuerySchema)) query: unknown,
  ): Promise<unknown> {
    return this.emails.listSuggestions(authOf(req), query as SuggestionsQuery);
  }

  @RequireScopes('activities:manage', 'contacts:manage')
  @Post('suggestions/:id/convert')
  async convert(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(convertSuggestionSchema)) body: unknown,
  ): Promise<unknown> {
    return this.emails.convertSuggestion(authOf(req), id, body as ConvertSuggestionInput);
  }

  @RequireScopes('activities:manage')
  @Post('send')
  async send(
    @Req() req: Request,
    @Body(new ZodValidationPipe(sendEmailSchema)) body: unknown,
  ): Promise<unknown> {
    return this.emails.send(authOf(req), body as SendEmailInput);
  }
}

@Controller('email-templates')
export class EmailTemplatesController {
  constructor(@Inject(EmailsService) private readonly emails: EmailsService) {}

  @RequireScopes('activities:manage')
  @Post()
  async create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(createTemplateSchema)) body: unknown,
  ): Promise<unknown> {
    return this.emails.createTemplate(authOf(req), body as CreateTemplateInput);
  }

  @RequireScopes('activities:read')
  @Get()
  async list(@Req() req: Request): Promise<unknown> {
    return this.emails.listTemplates(authOf(req));
  }

  @RequireScopes('activities:read')
  @Get(':id')
  async getById(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.emails.getTemplate(authOf(req), id);
  }

  @RequireScopes('activities:manage')
  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateTemplateSchema)) body: unknown,
  ): Promise<unknown> {
    return this.emails.updateTemplate(authOf(req), id, body as UpdateTemplateInput);
  }

  @RequireScopes('activities:manage')
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.emails.removeTemplate(authOf(req), id);
  }
}
