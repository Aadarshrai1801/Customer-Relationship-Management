import { Module } from '@nestjs/common';
import { QuotesController, QuotePublicController } from './quotes.controller';
import { QuotesService } from './quotes.service';

@Module({
  controllers: [QuotesController, QuotePublicController],
  providers: [QuotesService],
  exports: [QuotesService],
})
export class QuotesModule {}
