import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AllowUnverified } from '../rbac/allow-unverified.decorator';
import { TwoFactorService } from './two-factor.service';
import {
  confirmPasswordSchema,
  enableTwoFactorSchema,
  verifyTwoFactorSchema,
  type ConfirmPasswordInput,
  type EnableTwoFactorInput,
  type VerifyTwoFactorInput,
} from './two-factor.schemas';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller('auth/2fa')
export class TwoFactorController {
  constructor(@Inject(TwoFactorService) private readonly tfa: TwoFactorService) {}

  @AllowUnverified()
  @Post('setup')
  async setup(@Req() req: Request): Promise<unknown> {
    return this.tfa.setup(authOf(req));
  }

  @AllowUnverified()
  @Post('enable')
  @HttpCode(HttpStatus.OK)
  async enable(
    @Req() req: Request,
    @Body(new ZodValidationPipe(enableTwoFactorSchema)) body: unknown,
  ): Promise<unknown> {
    return this.tfa.enable(authOf(req), body as EnableTwoFactorInput);
  }

  @AllowUnverified()
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verify(
    @Req() req: Request,
    @Body(new ZodValidationPipe(verifyTwoFactorSchema)) body: unknown,
  ): Promise<unknown> {
    return this.tfa.verify(authOf(req), body as VerifyTwoFactorInput);
  }

  @Post('disable')
  @HttpCode(HttpStatus.OK)
  async disable(
    @Req() req: Request,
    @Body(new ZodValidationPipe(confirmPasswordSchema)) body: unknown,
  ): Promise<unknown> {
    await this.tfa.disable(authOf(req), (body as ConfirmPasswordInput).password);
    return { ok: true };
  }

  @Post('backup-codes/regenerate')
  @HttpCode(HttpStatus.OK)
  async regenerate(
    @Req() req: Request,
    @Body(new ZodValidationPipe(confirmPasswordSchema)) body: unknown,
  ): Promise<unknown> {
    return this.tfa.regenerateCodes(authOf(req), (body as ConfirmPasswordInput).password);
  }
}
