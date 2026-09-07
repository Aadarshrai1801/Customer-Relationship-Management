import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { Public } from '../common/public.decorator';
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

  @RequireScopes('activities:read')
  @Get(':id/tracking')
  async tracking(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.emails.trackingSummary(authOf(req), id);
  }

  @RequireScopes('activities:read')
  @Get('inbox/list')
  async inbox(
    @Req() req: Request,
    @Query(new ZodValidationPipe(suggestionsQuerySchema)) query: unknown,
  ): Promise<unknown> {
    return this.emails.listInbox(authOf(req), query as SuggestionsQuery);
  }

  @RequireScopes('activities:manage')
  @Post('inbox/:id/claim')
  async claim(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.emails.claimInboxMessage(authOf(req), id);
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

const PIXEL_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAP///////yH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
  'base64',
);

@Controller('email-tracking')
export class EmailTrackingController {
  constructor(@Inject(EmailsService) private readonly emails: EmailsService) {}

  /** Always 200s, even for bad tokens — validity must not leak. */
  @Public()
  @Get('open/:token')
  @Header('Content-Type', 'image/gif')
  @Header('Cache-Control', 'no-store')
  async open(
    @Param('token') token: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Buffer> {
    await this.emails.recordOpen(token, req.headers['user-agent']);
    void res;
    return PIXEL_GIF;
  }

  @Public()
  @Get('click/:token')
  async click(
    @Param('token') token: string,
    @Query('u') url: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const target = await this.emails.recordClick(token, url ?? '', req.headers['user-agent']);
    if (!target) {
      res.status(404).json({ message: 'Not found', code: 'NOT_FOUND' });
      return;
    }
    res.redirect(302, target);
  }
}
