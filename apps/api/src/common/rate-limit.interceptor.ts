import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';

const WINDOW_MS = 60_000;
const DEFAULT_LIMIT_PER_MINUTE = 600;

/**
 * Global fixed-window rate limiter (PRD 4.14: limits communicated via
 * X-RateLimit-* response headers). Keyed by authenticated user, falling
 * back to IP for public routes. In-memory like AttemptThrottle — correct
 * for a single instance; multi-instance needs a shared store.
 */
@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { auth?: { user?: { id?: string } }; ip?: string }>();
    const res = context.switchToHttp().getResponse<Response>();
    const limit = this.limit();
    const now = Date.now();
    const key = req.auth?.user?.id ? `u:${req.auth.user.id}` : `ip:${req.ip ?? 'unknown'}`;
    let state = this.windows.get(key);
    if (!state || now >= state.resetAt) {
      state = { count: 0, resetAt: now + WINDOW_MS };
      this.windows.set(key, state);
      if (this.windows.size > 10000) this.purge(now);
    }
    state.count += 1;
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - state.count)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(state.resetAt / 1000)));
    if (state.count > limit) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((state.resetAt - now) / 1000))));
      throw new HttpException(
        { message: 'Rate limit exceeded, try again shortly', code: 'RATE_LIMITED' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return next.handle();
  }

  private limit(): number {
    const configured = Number(process.env.RATE_LIMIT_PER_MINUTE);
    return Number.isFinite(configured) && configured > 0
      ? Math.floor(configured)
      : DEFAULT_LIMIT_PER_MINUTE;
  }

  private purge(now: number): void {
    for (const [key, state] of this.windows) {
      if (now >= state.resetAt) this.windows.delete(key);
    }
  }
}
