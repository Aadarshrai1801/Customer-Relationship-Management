import { Module } from '@nestjs/common';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module';
import { PipelinesModule } from '../pipelines/pipelines.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { CompetitorsService } from './competitors.service';
import { CompetitorsController, DealsController } from './deals.controller';
import { DealsService } from './deals.service';

@Module({
  imports: [CustomFieldsModule, PipelinesModule, WorkflowsModule],
  controllers: [DealsController, CompetitorsController],
  providers: [DealsService, CompetitorsService],
  exports: [DealsService],
})
export class DealsModule {}
