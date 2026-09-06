import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { generateSecret, generateURI, verifySync } from 'otplib';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  organizations,
  sessions,
  twoFactor,
  users,
  type OrganizationSecuritySettings,
} from '@nexus/db';
import { TenantDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { FieldCrypto } from '../crypto/crypto.module';
import { PasswordService } from '../crypto/password.service';
import { AttemptThrottle } from './attempt-throttle.service';
import { TFA_THROTTLE } from './throttle.tokens';
import { AuditService } from '../audit/audit.service';
import type { EnableTwoFactorInput, VerifyTwoFactorInput } from './two-factor.schemas';

const SECRET_PURPOSE = '2fa-secret-v1';
const CODES_PURPOSE = '2fa-codes-v1';
const BACKUP_CODE_COUNT = 10;

function hashBackupCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

function codesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function newBackupCodes(): string[] {
  return Array.from({ length: BACKUP_CODE_COUNT }, () =>
    randomBytes(5).toString('hex').toUpperCase(),
  );
}

@Injectable()
export class TwoFactorService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(TFA_THROTTLE) private readonly throttle: AttemptThrottle,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async setup(auth: AuthContext): Promise<{ secret: string; otpauthUrl: string }> {
    await this.assertCanManage(auth);
    const secret = await generateSecret();
    await this.tenantDb.tx(auth.org.id, (db) =>
      db
        .insert(twoFactor)
        .values({
          userId: auth.user.id,
          orgId: auth.org.id,
          secret: this.crypto.encrypt(secret, SECRET_PURPOSE),
          enabledAt: null,
          backupCodes: this.crypto.encrypt('[]', CODES_PURPOSE),
        })
        .onConflictDoUpdate({
          target: twoFactor.userId,
          set: {
            secret: this.crypto.encrypt(secret, SECRET_PURPOSE),
            enabledAt: null,
            backupCodes: this.crypto.encrypt('[]', CODES_PURPOSE),
            updatedAt: new Date(),
          },
        }),
    );
    const otpauthUrl = await generateURI({
      issuer: 'Nexus CRM',
      label: auth.user.email,
      secret,
    });
    return { secret, otpauthUrl };
  }

  async enable(
    auth: AuthContext,
    input: EnableTwoFactorInput,
  ): Promise<{ backupCodes: string[]; verified: boolean }> {
    await this.assertCanManage(auth);
    const row = await this.getRow(auth);
    if (!row) {
      throw new ConflictException({
        message: 'Call setup first to generate a secret',
        code: 'TWO_FACTOR_SETUP_REQUIRED',
      });
    }
    const secret = this.crypto.decrypt(row.secret, SECRET_PURPOSE);
    const { valid } = verifySync({ secret, token: input.code, epochTolerance: 30 });
    if (!valid) {
      throw new BadRequestException({
        message: 'Invalid verification code',
        code: 'INVALID_TWO_FACTOR_CODE',
      });
    }
    const backupCodes = newBackupCodes();
    await this.tenantDb.tx(auth.org.id, async (db) => {
      await db
        .update(twoFactor)
        .set({
          enabledAt: new Date(),
          backupCodes: this.crypto.encrypt(
            JSON.stringify(backupCodes.map(hashBackupCode)),
            CODES_PURPOSE,
          ),
          updatedAt: new Date(),
        })
        .where(eq(twoFactor.userId, auth.user.id));
      await this.markSessionVerified(db, auth.sessionId);
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: '2fa.enabled',
        entityType: 'user',
        entityId: auth.user.id,
        newValues: { method: 'totp' },
      });
    });
    return { backupCodes, verified: true };
  }

  async verify(auth: AuthContext, input: VerifyTwoFactorInput): Promise<{ verified: true }> {
    const throttleKey = `2fa:${auth.sessionId}`;
    this.throttle.check(throttleKey);
    const row = await this.getRow(auth);
    if (!row?.enabledAt) {
      throw new ConflictException({
        message: 'Two-factor authentication is not enrolled',
        code: 'TWO_FACTOR_NOT_ENROLLED',
      });
    }
    let ok = false;
    if (input.code) {
      const secret = this.crypto.decrypt(row.secret, SECRET_PURPOSE);
      ok = verifySync({ secret, token: input.code, epochTolerance: 30 }).valid;
    } else if (input.backupCode) {
      ok = await this.consumeBackupCode(auth, row.backupCodes, input.backupCode);
    }
    if (!ok) {
      this.throttle.recordFailure(throttleKey);
      await this.audit.record({
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'auth.2fa.failed',
        entityType: 'user',
        entityId: auth.user.id,
        newValues: { via: input.backupCode ? 'backup_code' : 'totp' },
      });
      throw new UnauthorizedException({
        message: 'Invalid two-factor code',
        code: 'INVALID_TWO_FACTOR_CODE',
      });
    }
    this.throttle.recordSuccess(throttleKey);
    await this.tenantDb.tx(auth.org.id, (db) => this.markSessionVerified(db, auth.sessionId));
    await this.audit.record({
      orgId: auth.org.id,
      actorUserId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'auth.2fa.verified',
      entityType: 'user',
      entityId: auth.user.id,
      newValues: { via: input.backupCode ? 'backup_code' : 'totp' },
    });
    return { verified: true as const };
  }

  async disable(auth: AuthContext, password: string): Promise<void> {
    await this.assertPassword(auth, password);
    await this.tenantDb.tx(auth.org.id, async (db) => {
      await db.delete(twoFactor).where(eq(twoFactor.userId, auth.user.id));
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: '2fa.disabled',
        entityType: 'user',
        entityId: auth.user.id,
      });
    });
  }

  async regenerateCodes(auth: AuthContext, password: string): Promise<{ backupCodes: string[] }> {
    const row = await this.getRow(auth);
    if (!row?.enabledAt) {
      throw new ConflictException({
        message: 'Two-factor authentication is not enrolled',
        code: 'TWO_FACTOR_NOT_ENROLLED',
      });
    }
    await this.assertPassword(auth, password);
    const backupCodes = newBackupCodes();
    await this.tenantDb.tx(auth.org.id, async (db) => {
      await db
        .update(twoFactor)
        .set({
          backupCodes: this.crypto.encrypt(
            JSON.stringify(backupCodes.map(hashBackupCode)),
            CODES_PURPOSE,
          ),
          updatedAt: new Date(),
        })
        .where(eq(twoFactor.userId, auth.user.id));
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: '2fa.backup_codes_regenerated',
        entityType: 'user',
        entityId: auth.user.id,
      });
    });
    return { backupCodes };
  }

  private async assertCanManage(auth: AuthContext): Promise<void> {
    const policy = await this.policyFor(auth.org.id);
    if (policy === 'off') {
      throw new ForbiddenException({
        message: 'Two-factor authentication is disabled for this workspace',
        code: 'TWO_FACTOR_DISABLED',
      });
    }
    if (auth.twoFactorVerified) return;
    const row = await this.getRow(auth);
    if (policy === 'required' && !row?.enabledAt) return;
    throw new ForbiddenException({
      message: 'Verify your session before managing two-factor settings',
      code: 'TWO_FACTOR_SETUP_DENIED',
    });
  }

  private async assertPassword(auth: AuthContext, password: string): Promise<void> {
    const [user] = await this.tenantDb.tx(auth.org.id, (db) =>
      db.select().from(users).where(eq(users.id, auth.user.id)),
    );
    if (!user?.passwordHash) {
      throw new BadRequestException({
        message: 'Password confirmation is not available for this account',
        code: 'PASSWORD_AUTH_DISABLED',
      });
    }
    const ok = await this.passwords.verify(user.passwordHash, password);
    if (!ok) {
      throw new UnauthorizedException({
        message: 'Invalid password',
        code: 'INVALID_CREDENTIALS',
      });
    }
  }

  private async consumeBackupCode(
    auth: AuthContext,
    encrypted: string,
    candidate: string,
  ): Promise<boolean> {
    const stored = JSON.parse(this.crypto.decrypt(encrypted, CODES_PURPOSE)) as string[];
    const candidateHash = hashBackupCode(candidate.trim().toUpperCase());
    const remaining = stored.filter((hash) => !codesEqual(hash, candidateHash));
    if (remaining.length === stored.length) return false;
    await this.tenantDb.tx(auth.org.id, (db) =>
      db
        .update(twoFactor)
        .set({
          backupCodes: this.crypto.encrypt(JSON.stringify(remaining), CODES_PURPOSE),
          updatedAt: new Date(),
        })
        .where(eq(twoFactor.userId, auth.user.id)),
    );
    return true;
  }

  private async getRow(
    auth: AuthContext,
  ): Promise<{ secret: string; backupCodes: string; enabledAt: Date | null } | null> {
    const [row] = await this.tenantDb.tx(auth.org.id, (db) =>
      db.select().from(twoFactor).where(eq(twoFactor.userId, auth.user.id)),
    );
    return row ?? null;
  }

  private async policyFor(orgId: string): Promise<OrganizationSecuritySettings['twoFactorPolicy']> {
    const [org] = await this.tenantDb.tx(orgId, (db) =>
      db.select().from(organizations).where(eq(organizations.id, orgId)),
    );
    return org?.securitySettings.twoFactorPolicy ?? 'optional';
  }

  private async markSessionVerified(db: NexusDb, sessionId: string): Promise<void> {
    await db.update(sessions).set({ twoFactorVerified: true }).where(eq(sessions.id, sessionId));
  }
}
