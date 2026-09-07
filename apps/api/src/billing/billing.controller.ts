import { Body, Controller, Get, Inject, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireScopes } from '../rbac/require-scopes.decorator';
import { BillingService } from './billing.service';
import {
  applySeatsSchema,
  previewSeatsSchema,
  type ApplySeatsInput,
  type PreviewSeatsInput,
} from './billing.schemas';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller('billing')
export class BillingController {
  constructor(@Inject(BillingService) private readonly billing: BillingService) {}

  @RequireScopes('org:read')
  @Get('subscription')
  async subscription(@Req() req: Request): Promise<unknown> {
    return this.billing.getSubscription(authOf(req));
  }

  @RequireScopes('org:manage')
  @Post('seats/preview')
  async preview(
    @Req() req: Request,
    @Body(new ZodValidationPipe(previewSeatsSchema)) body: unknown,
  ): Promise<unknown> {
    this.billing.assertBillingManager(authOf(req));
    return this.billing.previewSeats(authOf(req), body as PreviewSeatsInput);
  }

  @RequireScopes('org:manage')
  @Post('seats')
  async apply(
    @Req() req: Request,
    @Body(new ZodValidationPipe(applySeatsSchema)) body: unknown,
  ): Promise<unknown> {
    this.billing.assertBillingManager(authOf(req));
    return this.billing.applySeats(authOf(req), body as ApplySeatsInput);
  }

  @RequireScopes('org:read')
  @Get('invoices')
  async invoices(@Req() req: Request): Promise<unknown> {
    return this.billing.listInvoices(authOf(req));
  }
}
