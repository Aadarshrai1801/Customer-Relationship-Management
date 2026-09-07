import { Module } from '@nestjs/common';
import { WorkflowsController } from './workflows.controller';
import { WorkflowEngine } from './workflow-engine.service';
import { WorkflowsService } from './workflows.service';

@Module({
  controllers: [WorkflowsController],
  providers: [WorkflowsService, WorkflowEngine],
  exports: [WorkflowsService, WorkflowEngine],
})
export class WorkflowsModule {}
