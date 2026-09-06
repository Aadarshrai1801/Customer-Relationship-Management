import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { RolesModule } from './roles/roles.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [DatabaseModule, AuthModule, UsersModule, RolesModule],
  controllers: [HealthController],
})
export class AppModule {}
