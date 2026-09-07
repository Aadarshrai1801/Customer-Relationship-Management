import { Module } from '@nestjs/common';
import { TerritoriesController } from './territories.controller';
import { TerritoriesService } from './territories.service';

@Module({
  controllers: [TerritoriesController],
  providers: [TerritoriesService],
  exports: [TerritoriesService],
})
export class TerritoriesModule {}
