import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { provideBillingProvider } from './billing.provider';

@Module({
  controllers: [BillingController],
  providers: [BillingService, provideBillingProvider()],
  exports: [BillingService],
})
export class BillingModule {}
