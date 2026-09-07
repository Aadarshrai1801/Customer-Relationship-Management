import { Controller, Get, Inject, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { OnboardingService } from './onboarding.service';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

/**
 * Personal setup checklist — intentionally outside the scope system so
 * every role (including viewers) sees its own onboarding state.
 */
@Controller('onboarding')
export class OnboardingController {
  constructor(@Inject(OnboardingService) private readonly onboarding: OnboardingService) {}

  @Get('status')
  async status(@Req() req: Request): Promise<unknown> {
    return this.onboarding.status(authOf(req));
  }
}
