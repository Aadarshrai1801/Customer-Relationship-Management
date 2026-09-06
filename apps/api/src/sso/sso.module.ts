import { Module } from '@nestjs/common';
import { SessionModule } from '../auth/session.module';
import { SsoService } from './sso.service';
import { OidcService } from './oidc.service';
import { SamlService } from './saml.service';
import { SsoAdminController } from './sso-admin.controller';
import { SsoLoginController } from './sso-login.controller';

@Module({
  imports: [SessionModule],
  controllers: [SsoAdminController, SsoLoginController],
  providers: [SsoService, OidcService, SamlService],
  exports: [SsoService],
})
export class SsoModule {}
