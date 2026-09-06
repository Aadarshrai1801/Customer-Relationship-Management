import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { AttemptThrottle } from './attempt-throttle.service';
import { LOGIN_THROTTLE, TFA_THROTTLE } from './throttle.tokens';
import { MailService } from './mail.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import { TwoFactorController } from './two-factor.controller';
import { TwoFactorService } from './two-factor.service';

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

@Module({
  controllers: [AuthController, TwoFactorController],
  providers: [
    AuthService,
    SessionService,
    PasswordService,
    MailService,
    TwoFactorService,
    {
      provide: LOGIN_THROTTLE,
      useFactory: () =>
        new AttemptThrottle({
          maxAttempts: 5,
          windowMs: FIFTEEN_MINUTES_MS,
          message: 'Too many failed login attempts. Try again later.',
          code: 'LOGIN_THROTTLED',
        }),
    },
    {
      provide: TFA_THROTTLE,
      useFactory: () =>
        new AttemptThrottle({
          maxAttempts: 5,
          windowMs: FIFTEEN_MINUTES_MS,
          message: 'Too many failed verification attempts. Try again later.',
          code: 'TWO_FACTOR_THROTTLED',
        }),
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AuthModule {}
