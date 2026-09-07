import { Module } from '@nestjs/common';
import { BookingPublicController, SchedulingController } from './scheduling.controller';
import { SchedulingService } from './scheduling.service';

@Module({
  controllers: [SchedulingController, BookingPublicController],
  providers: [SchedulingService],
  exports: [SchedulingService],
})
export class SchedulingModule {}
