import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import type { Configuration } from 'openid-client';
import { SsoService } from './sso.service';

@Injectable()
export class OidcService {
  private readonly logger = new Logger(OidcService.name);

  constructor(@Inject(SsoService) private readonly sso: SsoService) {}

  async startLogin(orgSlug: string): Promise<string> {
    const org = await this.sso.orgBySlug(orgSlug);
    const row = await this.sso.enabledConfig(org.id, 'oidc');
    const json = this.sso.decryptConfig(row);
    if (json.kind !== 'oidc') throw new Error('SSO config kind mismatch');
    this.assertIssuerAllowed(json.issuer);

    const oidc = await import('openid-client');
    const insecure = new URL(json.issuer).protocol === 'http:';
    const config = await oidc.discovery(
      new URL(json.issuer),
      json.clientId,
      { client_secret: json.clientSecret },
      oidc.ClientSecretBasic(json.clientSecret),
      // HTTP issuers only pass config-time validation for local dev/test.
      insecure ? { execute: [oidc.allowInsecureRequests] } : undefined,
    );

    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const { state } = await this.sso.createStateRow({
      orgId: org.id,
      provider: 'oidc',
      codeVerifier,
      nonce,
    });
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: this.sso.oidcCallbackUrl(org.slug),
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return url.toString();
  }

  async handleCallback(
    orgSlug: string,
    query: Record<string, string | undefined>,
    meta: { ipAddress?: string; userAgent?: string },
  ): Promise<{ redirect: string; cookie?: { token: string; expiresAt: Date } }> {
    if (query['error']) {
      return {
        redirect: this.sso.errorRedirect(String(query['error_description'] ?? query['error'])),
      };
    }
    const code = query['code'];
    const state = query['state'];
    if (!code || !state) {
      return { redirect: this.sso.errorRedirect('missing_parameters') };
    }
    let consumed;
    try {
      consumed = await this.sso.consumeStateRow('oidc', state);
    } catch {
      return { redirect: this.sso.errorRedirect('invalid_session') };
    }
    const org = await this.sso.orgBySlug(orgSlug);
    if (org.id !== consumed.orgId) {
      return { redirect: this.sso.errorRedirect('organization_mismatch') };
    }
    const row = await this.sso.enabledConfig(org.id, 'oidc');
    const json = this.sso.decryptConfig(row);
    if (json.kind !== 'oidc') {
      return { redirect: this.sso.errorRedirect('misconfigured') };
    }
    if (!consumed.codeVerifier || !consumed.nonce) {
      return { redirect: this.sso.errorRedirect('invalid_session') };
    }
    const oidc = await import('openid-client');
    let config: Configuration;
    try {
      const insecure = new URL(json.issuer).protocol === 'http:';
      config = await oidc.discovery(
        new URL(json.issuer),
        json.clientId,
        { client_secret: json.clientSecret },
        oidc.ClientSecretBasic(json.clientSecret),
        insecure ? { execute: [oidc.allowInsecureRequests] } : undefined,
      );
      const callbackUrl = new URL(this.sso.oidcCallbackUrl(org.slug));
      callbackUrl.searchParams.set('code', code);
      callbackUrl.searchParams.set('state', state);
      const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: consumed.codeVerifier,
        expectedState: state,
        expectedNonce: consumed.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims?.sub) {
        return { redirect: this.sso.errorRedirect('missing_subject') };
      }
      const userinfo = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub);
      const email = typeof userinfo.email === 'string' ? userinfo.email : undefined;
      if (!email || userinfo.email_verified !== true) {
        return { redirect: this.sso.errorRedirect('email_not_verified') };
      }
      const name =
        typeof userinfo.name === 'string' && userinfo.name.trim().length > 0
          ? userinfo.name
          : undefined;
      const result = await this.sso.provisionOrLinkAndIssue({
        orgId: org.id,
        provider: 'oidc',
        subject: claims.sub,
        email,
        name,
        meta,
      });
      return {
        redirect: this.sso.successRedirect(),
        cookie: { token: result.session.token, expiresAt: result.session.expiresAt },
      };
    } catch (err) {
      this.logger.warn(`OIDC callback failed for org ${org.slug}: ${(err as Error).message}`);
      return { redirect: this.sso.errorRedirect('login_failed') };
    }
  }

  private assertIssuerAllowed(issuer: string): void {
    if (new URL(issuer).protocol === 'http:' && process.env.NODE_ENV === 'production') {
      throw new UnauthorizedException({
        message: 'Insecure issuer is not allowed in production',
        code: 'SSO_INSECURE_ISSUER',
      });
    }
  }
}
