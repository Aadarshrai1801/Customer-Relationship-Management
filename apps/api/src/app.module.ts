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
import { ContactsModule } from './contacts/contacts.module';
import { AccountsModule } from './accounts/accounts.module';
import { NotesModule } from './notes/notes.module';
import { TimelineModule } from './timeline/timeline.module';
import { ImportsModule } from './imports/imports.module';
import { LeadsModule } from './leads/leads.module';
import { PipelinesModule } from './pipelines/pipelines.module';
import { DealsModule } from './deals/deals.module';
import { ProductsModule } from './products/products.module';
import { TasksModule } from './tasks/tasks.module';
import { EmailsModule } from './emails/emails.module';
import { ReportsModule } from './reports/reports.module';
import { CollaborationModule } from './collaboration/collaboration.module';
import { LeadRoutingModule } from './lead-routing/lead-routing.module';
import { NotificationsModule } from './notifications/notifications.module';
import { WebToLeadModule } from './web-to-lead/web-to-lead.module';
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
    ContactsModule,
    AccountsModule,
    NotesModule,
    TimelineModule,
    ImportsModule,
    LeadsModule,
    PipelinesModule,
    DealsModule,
    ProductsModule,
    TasksModule,
    EmailsModule,
    ReportsModule,
    CollaborationModule,
    LeadRoutingModule,
    NotificationsModule,
    WebToLeadModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
