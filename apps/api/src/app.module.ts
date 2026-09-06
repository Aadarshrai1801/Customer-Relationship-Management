import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { CryptoModule } from './crypto/crypto.module';
import { AuditModule } from './audit/audit.module';
import { QueueModule } from './queue/queue.module';
import { MailModule } from './mail/mail.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { RolesModule } from './roles/roles.module';
import { OrgModule } from './org/org.module';
import { PrivacyModule } from './privacy/privacy.module';
import { CustomFieldsModule } from './custom-fields/custom-fields.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    DatabaseModule,
    CryptoModule,
    AuditModule,
    QueueModule,
    MailModule,
    AuthModule,
    UsersModule,
    RolesModule,
    OrgModule,
    PrivacyModule,
    CustomFieldsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
