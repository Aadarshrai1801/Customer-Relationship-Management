import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../common/public.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireScopes } from '../rbac/require-scopes.decorator';
import { AuthService } from './auth.service';
import {
  acceptInviteSchema,
  confirmResetSchema,
  createInviteSchema,
  loginSchema,
  requestResetSchema,
  signupSchema,
  type AcceptInviteInput,
  type ConfirmResetInput,
  type CreateInviteInput,
  type LoginInput,
  type RequestResetInput,
  type SignupInput,
} from './auth.schemas';
import { SESSION_COOKIE_NAME, clearedCookieOptions, cookieOptions } from './tokens';

function requestMeta(req: Request): { ipAddress?: string; userAgent?: string } {
  const userAgent = req.headers['user-agent'];
  return { ipAddress: req.ip, userAgent: Array.isArray(userAgent) ? userAgent[0] : userAgent };
}

function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  const maxAgeSeconds = Math.max(60, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  res.cookie(SESSION_COOKIE_NAME, token, cookieOptions(maxAgeSeconds));
}

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Post('signup')
  async signup(
    @Body(new ZodValidationPipe(signupSchema)) body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const result = await this.auth.signup(body as SignupInput, requestMeta(req));
    setSessionCookie(res, result.session.token, result.session.expiresAt);
    return { user: result.user, org: result.org };
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const result = await this.auth.login(body as LoginInput, requestMeta(req));
    setSessionCookie(res, result.session.token, result.session.expiresAt);
    return { user: result.user, org: result.org };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<unknown> {
    if (!req.auth) throw new UnauthorizedException();
    await this.auth.logout(req.auth);
    res.cookie(SESSION_COOKIE_NAME, '', clearedCookieOptions());
    return { ok: true };
  }

  @Get('me')
  async me(@Req() req: Request): Promise<unknown> {
    if (!req.auth) throw new UnauthorizedException();
    return this.auth.me(req.auth);
  }

  @Public()
  @Post('password/request')
  @HttpCode(HttpStatus.OK)
  async requestReset(
    @Body(new ZodValidationPipe(requestResetSchema)) body: unknown,
  ): Promise<unknown> {
    await this.auth.requestPasswordReset(body as RequestResetInput);
    return { ok: true };
  }

  @Public()
  @Post('password/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmReset(
    @Body(new ZodValidationPipe(confirmResetSchema)) body: unknown,
  ): Promise<unknown> {
    await this.auth.confirmPasswordReset(body as ConfirmResetInput);
    return { ok: true };
  }

  @RequireScopes('users:invite')
  @Post('invites')
  async createInvite(
    @Body(new ZodValidationPipe(createInviteSchema)) body: unknown,
    @Req() req: Request,
  ): Promise<unknown> {
    if (!req.auth) throw new UnauthorizedException();
    return this.auth.createInvite(req.auth, body as CreateInviteInput);
  }

  @RequireScopes('users:read')
  @Get('invites')
  async listInvites(@Req() req: Request): Promise<unknown> {
    if (!req.auth) throw new UnauthorizedException();
    return this.auth.listInvites(req.auth);
  }

  @Public()
  @Get('invites/:token')
  async getInvite(@Param('token') token: string): Promise<unknown> {
    return this.auth.getInvite(token);
  }

  @Public()
  @Post('invites/accept')
  async acceptInvite(
    @Body(new ZodValidationPipe(acceptInviteSchema)) body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const result = await this.auth.acceptInvite(body as AcceptInviteInput, requestMeta(req));
    setSessionCookie(res, result.session.token, result.session.expiresAt);
    return { user: result.user, org: result.org };
  }
}
