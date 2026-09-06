import { Module } from '@nestjs/common';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module';
import { DedupModule } from '../dedup/dedup.module';
import { ImportsController } from './imports.controller';
import { ExportsController } from './exports.controller';
import { ImportsService } from './imports.service';
import { ExportsService } from './exports.service';

@Module({
  imports: [CustomFieldsModule, DedupModule],
  controllers: [ImportsController, ExportsController],
  providers: [ImportsService, ExportsService],
  exports: [ImportsService],
})
export class ImportsModule {}
