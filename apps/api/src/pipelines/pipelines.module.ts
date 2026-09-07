import { Module } from '@nestjs/common';
import { PipelinesService } from './pipelines.service';

@Module({
  providers: [PipelinesService],
  exports: [PipelinesService],
})
export class PipelinesModule {}
