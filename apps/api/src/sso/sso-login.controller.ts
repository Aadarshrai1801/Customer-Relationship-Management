import { Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Public } from '../common/public.decorator';
import { setSessionCookie } from '../auth/tokens';
import { requestMeta } from '../auth/auth.controller';
import { SsoService } from './sso.service';
import { OidcService } from './oidc.service';
import { SamlService } from './saml.service';

const resolveQuerySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
});

function finish(
  res: Response,
  result: { redirect: string; cookie?: { token: string; expiresAt: Date } },
): void {
  if (result.cookie) {
    setSessionCookie(res, result.cookie.token, result.cookie.expiresAt);
  }
  res.redirect(result.redirect);
}

@Controller()
export class SsoLoginController {
  constructor(
    @Inject(SsoService) private readonly sso: SsoService,
    @Inject(OidcService) private readonly oidc: OidcService,
    @Inject(SamlService) private readonly saml: SamlService,
  ) {}

  @Public()
  @Get('auth/sso/resolve')
  async resolve(@Query('email') email: string): Promise<unknown> {
    const parsed = resolveQuerySchema.safeParse({ email });
    if (!parsed.success) {
      return { orgs: [] };
    }
    return { orgs: await this.sso.resolveByEmail(parsed.data.email) };
  }

  @Public()
  @Get('auth/sso/oidc/:orgSlug/start')
  async oidcStart(@Param('orgSlug') orgSlug: string, @Res() res: Response): Promise<void> {
    try {
      res.redirect(await this.oidc.startLogin(orgSlug));
    } catch {
      res.redirect(this.sso.errorRedirect('start_failed'));
    }
  }

  @Public()
  @Get('auth/sso/oidc/:orgSlug/callback')
  async oidcCallback(
    @Param('orgSlug') orgSlug: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.oidc.handleCallback(
      orgSlug,
      req.query as Record<string, string | undefined>,
      requestMeta(req),
    );
    finish(res, result);
  }

  @Public()
  @Get('auth/sso/saml/:orgSlug/start')
  async samlStart(@Param('orgSlug') orgSlug: string, @Res() res: Response): Promise<void> {
    try {
      res.redirect(await this.saml.startLogin(orgSlug));
    } catch {
      res.redirect(this.sso.errorRedirect('start_failed'));
    }
  }

  @Public()
  @Post('auth/sso/saml/:orgSlug/acs')
  async samlAcs(
    @Param('orgSlug') orgSlug: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.saml.handleAcs(
      orgSlug,
      (req.body ?? {}) as Record<string, string | undefined>,
      requestMeta(req),
    );
    finish(res, result);
  }
}
