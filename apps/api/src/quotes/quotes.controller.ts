import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { Public } from '../common/public.decorator';
import { RequireScopes } from '../rbac/require-scopes.decorator';
import { QuotesService } from './quotes.service';
import {
  acceptQuoteSchema,
  createQuoteSchema,
  declineQuoteSchema,
  type AcceptQuoteInput,
  type CreateQuoteInput,
  type DeclineQuoteInput,
} from './quotes.schemas';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller('quotes')
export class QuotesController {
  constructor(@Inject(QuotesService) private readonly quotes: QuotesService) {}

  @RequireScopes('deals:manage')
  @Post()
  async create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(createQuoteSchema)) body: unknown,
  ): Promise<unknown> {
    return this.quotes.create(authOf(req), body as CreateQuoteInput);
  }

  @RequireScopes('deals:read')
  @Get()
  async list(@Req() req: Request, @Query('dealId') dealId?: string): Promise<unknown> {
    return this.quotes.list(authOf(req), dealId);
  }

  @RequireScopes('deals:read')
  @Get(':id')
  async getById(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.quotes.getById(authOf(req), id);
  }

  @RequireScopes('deals:manage')
  @Post(':id/send')
  async send(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { to?: string } = {},
  ): Promise<unknown> {
    return this.quotes.send(authOf(req), id, body?.to);
  }
}

@Controller('quotes-public')
export class QuotePublicController {
  constructor(@Inject(QuotesService) private readonly quotes: QuotesService) {}

  @Public()
  @Get(':token')
  async view(@Param('token') token: string): Promise<unknown> {
    return this.quotes.publicView(token);
  }

  @Public()
  @Post(':token/accept')
  async accept(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(acceptQuoteSchema)) body: unknown,
    @Req() req: Request,
  ): Promise<unknown> {
    return this.quotes.accept(token, body as AcceptQuoteInput, req.ip);
  }

  @Public()
  @Post(':token/decline')
  async decline(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(declineQuoteSchema)) body: unknown,
  ): Promise<unknown> {
    return this.quotes.decline(token, body as DeclineQuoteInput);
  }
}
