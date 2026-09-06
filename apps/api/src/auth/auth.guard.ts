import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../common/public.decorator';
import { ALLOW_UNVERIFIED_KEY } from '../rbac/allow-unverified.decorator';
import { REQUIRED_SCOPES_KEY } from '../rbac/require-scopes.decorator';
import { hasScope } from '../rbac/permissions';
import { SESSION_COOKIE_NAME } from './tokens';
import { SessionService } from './session.service';

@Injectable()
export class AuthGuard implements CanActivate {
  // NOTE: dependencies are injected explicitly via @Inject() (rather than
  // relying on emitted decorator metadata) so the classes also resolve under
  // esbuild-based runners (vitest), which do not emit design:paramtypes.
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const token = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
    const auth = await this.sessions.validate(token);
    if (!auth) {
      throw new UnauthorizedException({ message: 'Not authenticated', code: 'UNAUTHENTICATED' });
    }
    if (auth.user.status === 'suspended') {
      throw new ForbiddenException({ message: 'Account suspended', code: 'ACCOUNT_SUSPENDED' });
    }
    if (!auth.twoFactorVerified) {
      const allowUnverified = this.reflector.getAllAndOverride<boolean>(ALLOW_UNVERIFIED_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!allowUnverified) {
        throw new ForbiddenException({
          message: 'Two-factor verification required',
          code: 'TWO_FACTOR_REQUIRED',
        });
      }
    }
    const required =
      this.reflector.getAllAndOverride<string[]>(REQUIRED_SCOPES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    for (const scope of required) {
      if (!hasScope(auth.role.permissions, scope)) {
        throw new ForbiddenException({
          message: `Missing required scope: ${scope}`,
          code: 'SCOPE_FORBIDDEN',
        });
      }
    }
    req.auth = auth;
    return true;
  }
}
