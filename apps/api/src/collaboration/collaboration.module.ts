import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts/contacts.module';
import { AttachmentsController, CommentsController } from './collaboration.controller';
import { AttachmentsService } from './attachments.service';
import { CollaborationService } from './collaboration.service';

@Module({
  imports: [ContactsModule],
  controllers: [CommentsController, AttachmentsController],
  providers: [CollaborationService, AttachmentsService],
  exports: [CollaborationService, AttachmentsService],
})
export class CollaborationModule {}
