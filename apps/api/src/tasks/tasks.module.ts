import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts/contacts.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { ActivitiesController, CalendarSyncController, TasksController } from './tasks.controller';
import { CalendarSyncService } from './calendar-sync.service';
import { TasksReminderTasks } from './tasks-reminder.tasks';
import { TasksService } from './tasks.service';

@Module({
  imports: [ContactsModule, WorkflowsModule],
  controllers: [TasksController, ActivitiesController, CalendarSyncController],
  providers: [TasksService, CalendarSyncService, TasksReminderTasks],
  exports: [TasksService, CalendarSyncService],
})
export class TasksModule {}
