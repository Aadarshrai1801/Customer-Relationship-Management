import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts/contacts.module';
import { SequencesController } from './sequences.controller';
import { SequencesService } from './sequences.service';

@Module({
  imports: [ContactsModule],
  controllers: [SequencesController],
  providers: [SequencesService],
  exports: [SequencesService],
})
export class SequencesModule {}
