import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { CryptoModule } from './crypto/crypto.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { RolesModule } from './roles/roles.module';
import { OrgModule } from './org/org.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [DatabaseModule, CryptoModule, AuthModule, UsersModule, RolesModule, OrgModule],
  controllers: [HealthController],
})
export class AppModule {}
