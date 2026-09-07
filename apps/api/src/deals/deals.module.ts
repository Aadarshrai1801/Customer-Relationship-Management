import { Module } from '@nestjs/common';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module';
import { PipelinesModule } from '../pipelines/pipelines.module';
import { DealsController } from './deals.controller';
import { DealsService } from './deals.service';

@Module({
  imports: [CustomFieldsModule, PipelinesModule],
  controllers: [DealsController],
  providers: [DealsService],
  exports: [DealsService],
})
export class DealsModule {}
