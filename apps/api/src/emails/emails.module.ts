import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts/contacts.module';
import { SequencesModule } from '../sequences/sequences.module';
import {
  EmailsController,
  EmailTemplatesController,
  EmailTrackingController,
} from './emails.controller';
import { EmailsService } from './emails.service';

@Module({
  imports: [ContactsModule, SequencesModule],
  controllers: [EmailsController, EmailTemplatesController, EmailTrackingController],
  providers: [EmailsService],
  exports: [EmailsService],
})
export class EmailsModule {}
