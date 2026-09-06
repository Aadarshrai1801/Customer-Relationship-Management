import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  DEFAULT_ORGANIZATION_SECURITY_SETTINGS,
  DEFAULT_ORGANIZATION_SETTINGS,
  emailInvites,
  organizations,
  passwordResetTokens,
  roles,
  sessions,
  twoFactor,
  users,
  type NewOrganization,
  type NewRole,
  type Organization,
  type OrganizationSecuritySettings,
  type User,
} from '@nexus/db';
import { IdentityDb, TenantDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { SYSTEM_ROLE_SEEDS } from '../rbac/seeds';
import { PasswordService } from './password.service';
import { SessionService, type CreatedSession } from './session.service';
import { MailService } from './mail.service';
import { AttemptThrottle } from './attempt-throttle.service';
import { LOGIN_THROTTLE } from './throttle.tokens';
import { generateToken, hashToken } from './tokens';
import type {
  AcceptInviteInput,
  ConfirmResetInput,
  CreateInviteInput,
  LoginInput,
  RequestResetInput,
  SignupInput,
} from './auth.schemas';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  status: string;
  twoFactorEnrolled?: boolean;
  role: { id: string; key: string; name: string; permissions?: unknown };
}

export interface TwoFactorState {
  enrolled: boolean;
  required: boolean;
  verified: boolean;
}

export interface PublicOrg {
  id: string;
  name: string;
  slug: string;
}

const RESET_TTL_MS = 60 * 60 * 1000;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class AuthService {
  constructor(
    @Inject(IdentityDb) private readonly identityDb: IdentityDb,
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(LOGIN_THROTTLE) private readonly loginThrottle: AttemptThrottle,
  ) {}

  async signup(
    input: SignupInput,
    meta: { ipAddress?: string; userAgent?: string },
  ): Promise<{
    user: PublicUser;
    org: PublicOrg;
    session: CreatedSession;
    twoFactor: TwoFactorState;
  }> {
    const slug = await this.allocateSlug(input.slug ?? deriveSlug(input.orgName));
    const orgRow: NewOrganization = {
      name: input.orgName,
      slug,
      settings: DEFAULT_ORGANIZATION_SETTINGS,
      securitySettings: DEFAULT_ORGANIZATION_SECURITY_SETTINGS,
    };
    const [org] = await this.identityDb.db.insert(organizations).values(orgRow).returning();
    if (!org) throw new Error('Failed to create organization');

    const seedRoles: NewRole[] = SYSTEM_ROLE_SEEDS.map((r) => ({
      orgId: org.id,
      key: r.key,
      name: r.name,
      permissions: r.permissions,
      isSystem: true,
    }));
    const createdRoles = await this.identityDb.db.insert(roles).values(seedRoles).returning();
    const ownerRole = createdRoles.find((r) => r.key === 'owner');
    if (!ownerRole) throw new Error('Failed to seed roles');

    const [user] = await this.identityDb.db
      .insert(users)
      .values({
        orgId: org.id,
        email: input.email,
        name: input.name,
        passwordHash: await this.passwords.hash(input.password),
        status: 'active',
        roleId: ownerRole.id,
      })
      .returning();
    if (!user) throw new Error('Failed to create user');

    const { session, twoFactor } = await this.issueSession(user, org, meta);

    return {
      user: { ...toPublicUser(user, ownerRole), twoFactorEnrolled: twoFactor.enrolled },
      org: toPublicOrg(org),
      session,
      twoFactor,
    };
  }

  async login(
    input: LoginInput,
    meta: { ipAddress?: string; userAgent?: string },
  ): Promise<{
    user: PublicUser;
    org: PublicOrg;
    session: CreatedSession;
    twoFactor: TwoFactorState;
  }> {
    const throttleKey = `${meta.ipAddress ?? 'unknown'}:${input.email}`;
    this.loginThrottle.check(throttleKey);

    const matches = await this.identityDb.db
      .select({ user: users, org: organizations, role: roles })
      .from(users)
      .innerJoin(organizations, eq(users.orgId, organizations.id))
      .innerJoin(roles, eq(users.roleId, roles.id))
      .where(sql`lower(${users.email}) = ${input.email}`);

    const invalid = (): never => {
      this.loginThrottle.recordFailure(throttleKey);
      throw new UnauthorizedException({
        message: 'Invalid email or password',
        code: 'INVALID_CREDENTIALS',
      });
    };

    let match = matches[0];
    if (input.orgSlug) {
      match = matches.find((m) => m.org.slug.toLowerCase() === input.orgSlug!.toLowerCase());
      if (!match) invalid();
    } else if (matches.length > 1) {
      throw new ConflictException({
        message: 'This email belongs to multiple workspaces. Choose one.',
        code: 'MULTIPLE_ORGS',
        orgs: matches.map((m) => ({ slug: m.org.slug, name: m.org.name, status: m.user.status })),
      });
    } else if (!match) {
      invalid();
    }
    const { user, org, role } = match!;

    if (user.status === 'suspended') {
      throw new ForbiddenException({ message: 'Account suspended', code: 'ACCOUNT_SUSPENDED' });
    }
    if (!user.passwordHash) {
      this.loginThrottle.recordFailure(throttleKey);
      throw new UnauthorizedException({
        message: 'Password sign-in is disabled for this account',
        code: 'PASSWORD_AUTH_DISABLED',
      });
    }
    const ok = await this.passwords.verify(user.passwordHash, input.password);
    if (!ok) invalid();

    this.loginThrottle.recordSuccess(throttleKey);
    const { session, twoFactor } = await this.issueSession(user, org, meta);
    return {
      user: { ...toPublicUser(user, role), twoFactorEnrolled: twoFactor.enrolled },
      org: toPublicOrg(org),
      session,
      twoFactor,
    };
  }

  /**
   * Single decision point for session issuance after password verification:
   * resolves the org's 2FA policy + enrollment state into verified/unverified.
   */
  private async issueSession(
    user: Pick<User, 'id'>,
    org: Pick<Organization, 'id' | 'securitySettings'>,
    meta: { ipAddress?: string; userAgent?: string },
  ): Promise<{ session: CreatedSession; twoFactor: TwoFactorState }> {
    const policy = org.securitySettings.twoFactorPolicy ?? 'optional';
    const [tfa] = await this.tenantDb.tx(org.id, (db) =>
      db.select().from(twoFactor).where(eq(twoFactor.userId, user.id)),
    );
    const enrolled = !!tfa?.enabledAt;
    const required = policy === 'required' || (enrolled && policy !== 'off');
    const session = await this.sessions.createSession({
      userId: user.id,
      orgId: org.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      twoFactorVerified: !required,
      ttlDaysOverride: org.securitySettings.sessionTtlDays,
    });
    return { session, twoFactor: { enrolled, required, verified: !required } };
  }

  async logout(auth: AuthContext): Promise<void> {
    await this.sessions.revokeSession(auth.sessionId, auth.org.id);
  }

  me(auth: AuthContext): { user: PublicUser; org: PublicOrg } {
    return {
      user: {
        id: auth.user.id,
        email: auth.user.email,
        name: auth.user.name,
        status: auth.user.status,
        twoFactorEnrolled: auth.user.twoFactorEnrolled,
        role: {
          id: auth.role.id,
          key: auth.role.key,
          name: auth.role.name,
          permissions: auth.role.permissions,
        },
      },
      org: auth.org,
    };
  }

  async requestPasswordReset(input: RequestResetInput): Promise<void> {
    const matches = await this.identityDb.db
      .select({ user: users, org: organizations })
      .from(users)
      .innerJoin(organizations, eq(users.orgId, organizations.id))
      .where(sql`lower(${users.email}) = ${input.email}`);
    for (const { user, org } of matches) {
      if (user.status === 'suspended') continue;
      const token = generateToken();
      await this.identityDb.db.insert(passwordResetTokens).values({
        orgId: org.id,
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      });
      await this.mail.sendPasswordReset(user.email, org.name, token);
    }
  }

  async confirmPasswordReset(input: ConfirmResetInput): Promise<void> {
    const [tokenRow] = await this.identityDb.db
      .select()
      .from(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.tokenHash, hashToken(input.token)),
          isNull(passwordResetTokens.usedAt),
        ),
      );
    if (!tokenRow || tokenRow.expiresAt.getTime() <= Date.now()) {
      throw new GoneException({
        message: 'Reset link is invalid or expired',
        code: 'RESET_TOKEN_INVALID',
      });
    }

    const [userRow] = await this.identityDb.db
      .select({ user: users, org: organizations })
      .from(users)
      .innerJoin(organizations, eq(users.orgId, organizations.id))
      .where(eq(users.id, tokenRow.userId));
    if (!userRow || userRow.user.status === 'suspended') {
      throw new GoneException({
        message: 'Reset link is invalid or expired',
        code: 'RESET_TOKEN_INVALID',
      });
    }

    const minLength = minPasswordLength(userRow.org.securitySettings);
    if (input.newPassword.length < minLength) {
      throw new BadRequestException({
        message: `Password must be at least ${minLength} characters`,
        code: 'PASSWORD_TOO_SHORT',
      });
    }

    const passwordHash = await this.passwords.hash(input.newPassword);
    await this.tenantDb.tx(userRow.org.id, async (db) => {
      await db
        .update(users)
        .set({ passwordHash, status: 'active' })
        .where(eq(users.id, userRow.user.id));
      await db
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(eq(passwordResetTokens.id, tokenRow.id));
      await db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, userRow.user.id), isNull(sessions.revokedAt)));
    });
  }

  async createInvite(
    auth: AuthContext,
    input: CreateInviteInput,
  ): Promise<{ id: string; email: string; roleKey: string; expiresAt: Date }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const [role] = await db
        .select()
        .from(roles)
        .where(and(eq(roles.orgId, auth.org.id), eq(roles.key, input.roleKey)));
      if (!role) {
        throw new NotFoundException({ message: 'Role not found', code: 'ROLE_NOT_FOUND' });
      }
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.orgId, auth.org.id), sql`lower(${users.email}) = ${input.email}`));
      if (existing) {
        throw new ConflictException({
          message: 'A user with this email already exists in the workspace',
          code: 'USER_EXISTS',
        });
      }
      await db
        .delete(emailInvites)
        .where(
          and(
            eq(emailInvites.orgId, auth.org.id),
            sql`lower(${emailInvites.email}) = ${input.email}`,
            isNull(emailInvites.acceptedAt),
          ),
        );
      const token = generateToken();
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
      const [invite] = await db
        .insert(emailInvites)
        .values({
          orgId: auth.org.id,
          email: input.email,
          roleId: role.id,
          invitedBy: auth.user.id,
          tokenHash: hashToken(token),
          expiresAt,
        })
        .returning({
          id: emailInvites.id,
          email: emailInvites.email,
          expiresAt: emailInvites.expiresAt,
        });
      if (!invite) throw new Error('Failed to create invite');
      await this.mail.sendInvite(invite.email, auth.org.name, role.name, token);
      return { id: invite.id, email: invite.email, roleKey: role.key, expiresAt: invite.expiresAt };
    });
  }

  async listInvites(
    auth: AuthContext,
  ): Promise<
    Array<{ id: string; email: string; roleKey: string; expiresAt: Date; createdAt: Date }>
  > {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const rows = await db
        .select({
          id: emailInvites.id,
          email: emailInvites.email,
          roleKey: roles.key,
          expiresAt: emailInvites.expiresAt,
          createdAt: emailInvites.createdAt,
        })
        .from(emailInvites)
        .innerJoin(roles, eq(emailInvites.roleId, roles.id))
        .where(and(eq(emailInvites.orgId, auth.org.id), isNull(emailInvites.acceptedAt)));
      return rows;
    });
  }

  async getInvite(
    token: string,
  ): Promise<{ orgName: string; email: string; roleName: string; expiresAt: Date }> {
    const invite = await this.loadInvite(token);
    return {
      orgName: invite.org.name,
      email: invite.email,
      roleName: invite.role.name,
      expiresAt: invite.expiresAt,
    };
  }

  async acceptInvite(
    input: AcceptInviteInput,
    meta: { ipAddress?: string; userAgent?: string },
  ): Promise<{
    user: PublicUser;
    org: PublicOrg;
    session: CreatedSession;
    twoFactor: TwoFactorState;
  }> {
    const invite = await this.loadInvite(input.token);

    const created = await this.tenantDb.tx(invite.org.id, async (db) => {
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.orgId, invite.org.id), sql`lower(${users.email}) = ${invite.email}`));
      if (existing) {
        throw new ConflictException({
          message: 'A user with this email already exists in the workspace',
          code: 'USER_EXISTS',
        });
      }
      const [user] = await db
        .insert(users)
        .values({
          orgId: invite.org.id,
          email: invite.email,
          name: input.name,
          passwordHash: await this.passwords.hash(input.password),
          status: 'active',
          roleId: invite.role.id,
        })
        .returning();
      if (!user) throw new Error('Failed to create user');
      await db
        .update(emailInvites)
        .set({ acceptedAt: new Date() })
        .where(eq(emailInvites.id, invite.id));
      return user;
    });

    const { session, twoFactor } = await this.issueSession(created, invite.org, meta);
    return {
      user: { ...toPublicUser(created, invite.role), twoFactorEnrolled: twoFactor.enrolled },
      org: toPublicOrg(invite.org),
      session,
      twoFactor,
    };
  }

  private async allocateSlug(preferred: string): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = attempt === 0 ? preferred : `${preferred}-${attempt + 1}`;
      const [existing] = await this.identityDb.db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.slug, candidate));
      if (!existing) return candidate;
    }
    throw new ConflictException({
      message: 'Could not allocate workspace slug',
      code: 'SLUG_TAKEN',
    });
  }

  private async loadInvite(token: string): Promise<{
    id: string;
    email: string;
    expiresAt: Date;
    org: { id: string; name: string; slug: string; securitySettings: OrganizationSecuritySettings };
    role: { id: string; key: string; name: string };
  }> {
    const [invite] = await this.identityDb.db
      .select({ invite: emailInvites, org: organizations, role: roles })
      .from(emailInvites)
      .innerJoin(organizations, eq(emailInvites.orgId, organizations.id))
      .innerJoin(roles, eq(emailInvites.roleId, roles.id))
      .where(and(eq(emailInvites.tokenHash, hashToken(token)), isNull(emailInvites.acceptedAt)));
    if (!invite) {
      throw new NotFoundException({ message: 'Invitation not found', code: 'INVITE_NOT_FOUND' });
    }
    if (invite.invite.expiresAt.getTime() <= Date.now()) {
      throw new GoneException({ message: 'Invitation expired', code: 'INVITE_EXPIRED' });
    }
    return {
      id: invite.invite.id,
      email: invite.invite.email,
      expiresAt: invite.invite.expiresAt,
      org: {
        id: invite.org.id,
        name: invite.org.name,
        slug: invite.org.slug,
        securitySettings: invite.org.securitySettings,
      },
      role: { id: invite.role.id, key: invite.role.key, name: invite.role.name },
    };
  }
}

function deriveSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return base.length >= 2 ? base : 'org';
}

function minPasswordLength(settings: OrganizationSecuritySettings | null | undefined): number {
  return settings?.passwordMinLength ?? DEFAULT_ORGANIZATION_SECURITY_SETTINGS.passwordMinLength;
}

function toPublicUser(
  user: { id: string; email: string; name: string; status: string },
  role: { id: string; key: string; name: string },
): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    role: { id: role.id, key: role.key, name: role.name },
  };
}

function toPublicOrg(org: { id: string; name: string; slug: string }): PublicOrg {
  return { id: org.id, name: org.name, slug: org.slug };
}
