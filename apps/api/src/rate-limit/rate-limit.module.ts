import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RateLimitInterceptor } from '../common/rate-limit.interceptor';

@Module({
  providers: [{ provide: APP_INTERCEPTOR, useClass: RateLimitInterceptor }],
})
export class RateLimitModule {}
