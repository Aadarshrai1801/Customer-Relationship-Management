import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

interface AttemptState {
  count: number;
  firstAt: number;
  blockedUntil: number | null;
}

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

/**
 * In-memory login throttle. Correct for a single instance; a multi-instance
 * deployment needs a shared store (Redis/DB) — flagged as a scaling follow-up.
 */
@Injectable()
export class LoginThrottle {
  private readonly attempts = new Map<string, AttemptState>();

  constructor() {
    const timer = setInterval(() => this.purge(), WINDOW_MS);
    timer.unref();
  }

  check(key: string): void {
    const state = this.attempts.get(key);
    if (state?.blockedUntil && Date.now() < state.blockedUntil) {
      throw new HttpException(
        {
          message: 'Too many failed login attempts. Try again later.',
          code: 'LOGIN_THROTTLED',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  recordFailure(key: string): void {
    const now = Date.now();
    const state = this.attempts.get(key);
    if (!state || now - state.firstAt > WINDOW_MS) {
      this.attempts.set(key, { count: 1, firstAt: now, blockedUntil: null });
      return;
    }
    state.count += 1;
    if (state.count >= MAX_ATTEMPTS) {
      state.blockedUntil = now + WINDOW_MS;
    }
  }

  recordSuccess(key: string): void {
    this.attempts.delete(key);
  }

  private purge(): void {
    const now = Date.now();
    for (const [key, state] of this.attempts) {
      if (now - state.firstAt > WINDOW_MS && (!state.blockedUntil || now > state.blockedUntil)) {
        this.attempts.delete(key);
      }
    }
  }
}
