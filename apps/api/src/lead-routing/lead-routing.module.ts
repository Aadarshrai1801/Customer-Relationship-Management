import { Module } from '@nestjs/common';
import { LeadRoutingController } from './lead-routing.controller';
import { LeadRoutingService } from './lead-routing.service';

@Module({
  controllers: [LeadRoutingController],
  providers: [LeadRoutingService],
  exports: [LeadRoutingService],
})
export class LeadRoutingModule {}
