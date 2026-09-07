import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts/contacts.module';
import { EmailsController, EmailTemplatesController } from './emails.controller';
import { EmailsService } from './emails.service';

@Module({
  imports: [ContactsModule],
  controllers: [EmailsController, EmailTemplatesController],
  providers: [EmailsService],
  exports: [EmailsService],
})
export class EmailsModule {}
