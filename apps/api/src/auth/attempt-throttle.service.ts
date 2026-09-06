import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

/**
 * Options allow per-surface tuning (login vs 2FA codes) while sharing one
 * implementation. Instances are built via factories (see AuthModule).
 */
export interface AttemptThrottleOptions {
  maxAttempts: number;
  windowMs: number;
  message: string;
  code: string;
}

interface AttemptState {
  count: number;
  firstAt: number;
  blockedUntil: number | null;
}

/**
 * In-memory attempt throttle. Correct for a single instance; a multi-instance
 * deployment needs a shared store (Redis/DB) — flagged as a scaling follow-up.
 */
@Injectable()
export class AttemptThrottle {
  private readonly attempts = new Map<string, AttemptState>();

  constructor(private readonly options: AttemptThrottleOptions) {
    const timer = setInterval(() => this.purge(), this.options.windowMs);
    timer.unref();
  }

  check(key: string): void {
    const state = this.attempts.get(key);
    if (state?.blockedUntil && Date.now() < state.blockedUntil) {
      throw new HttpException(
        { message: this.options.message, code: this.options.code },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  recordFailure(key: string): void {
    const now = Date.now();
    const state = this.attempts.get(key);
    if (!state || now - state.firstAt > this.options.windowMs) {
      this.attempts.set(key, { count: 1, firstAt: now, blockedUntil: null });
      return;
    }
    state.count += 1;
    if (state.count >= this.options.maxAttempts) {
      state.blockedUntil = now + this.options.windowMs;
    }
  }

  recordSuccess(key: string): void {
    this.attempts.delete(key);
  }

  private purge(): void {
    const now = Date.now();
    for (const [key, state] of this.attempts) {
      if (
        now - state.firstAt > this.options.windowMs &&
        (!state.blockedUntil || now > state.blockedUntil)
      ) {
        this.attempts.delete(key);
      }
    }
  }
}
