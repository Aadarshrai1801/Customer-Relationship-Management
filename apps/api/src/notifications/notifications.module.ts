import { Global, Module } from '@nestjs/common';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import { providePushProvider } from './push.provider';

@Global()
@Module({
  controllers: [NotificationsController, DevicesController],
  providers: [NotificationsService, NotificationPreferencesService, DevicesService, providePushProvider()],
  exports: [NotificationsService, NotificationPreferencesService, DevicesService],
})
export class NotificationsModule {}
