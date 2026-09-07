import { Module } from '@nestjs/common';
import { DashboardsController, ReportsController } from './reports.controller';
import { DashboardsService } from './dashboards.service';
import { ReportsService } from './reports.service';

@Module({
  controllers: [ReportsController, DashboardsController],
  providers: [ReportsService, DashboardsService],
  exports: [ReportsService, DashboardsService],
})
export class ReportsModule {}
