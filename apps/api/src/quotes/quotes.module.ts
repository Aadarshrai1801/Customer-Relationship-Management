import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { QuotesController, QuotePublicController } from './quotes.controller';
import { QuotesService } from './quotes.service';

@Module({
  imports: [ApprovalsModule],
  controllers: [QuotesController, QuotePublicController],
  providers: [QuotesService],
  exports: [QuotesService],
})
export class QuotesModule {}
