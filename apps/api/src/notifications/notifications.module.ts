import { Global, Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationPreferencesService } from './notification-preferences.service';

@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationPreferencesService],
  exports: [NotificationsService, NotificationPreferencesService],
})
export class NotificationsModule {}
