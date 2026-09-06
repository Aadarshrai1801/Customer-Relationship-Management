import { Module } from '@nestjs/common';
import { LeadsModule } from '../leads/leads.module';
import { WebToLeadController } from './web-to-lead.controller';
import { WebToLeadService } from './web-to-lead.service';

@Module({
  imports: [LeadsModule],
  controllers: [WebToLeadController],
  providers: [WebToLeadService],
  exports: [WebToLeadService],
})
export class WebToLeadModule {}
