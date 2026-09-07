import { Module } from '@nestjs/common';
import { SlaController } from './sla.controller';
import { SlaService } from './sla.service';

@Module({
  controllers: [SlaController],
  providers: [SlaService],
  exports: [SlaService],
})
export class SlaModule {}
