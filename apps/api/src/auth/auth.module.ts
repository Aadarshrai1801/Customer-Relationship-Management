import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { LoginThrottle } from './login-throttle.service';
import { MailService } from './mail.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionService,
    PasswordService,
    MailService,
    LoginThrottle,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AuthModule {}
