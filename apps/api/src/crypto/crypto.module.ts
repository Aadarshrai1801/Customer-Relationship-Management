import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { PasswordService } from './password.service';

const PREFIX = 'gcm1.';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Application-level encryption for sensitive columns (2FA secrets, backup
 * codes, later SSO material). AES-256-GCM with per-purpose subkeys derived
 * from a single master key via HKDF (domain separation).
 *
 * Fails fast at boot when FIELD_ENCRYPTION_KEY is missing or malformed —
 * silently running without encryption is worse than not starting.
 */
@Injectable()
export class FieldCrypto {
  constructor(@Inject('FIELD_CRYPTO_MASTER_KEY') private readonly master: Buffer) {}

  encrypt(plaintext: string, purpose: string): string {
    const key = this.subkey(purpose);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString('base64')}`;
  }

  decrypt(payload: string, purpose: string): string {
    if (!payload.startsWith(PREFIX)) throw new Error('Unsupported encrypted payload version');
    const raw = Buffer.from(payload.slice(PREFIX.length), 'base64');
    if (raw.length < IV_BYTES + TAG_BYTES + 1) throw new Error('Malformed encrypted payload');
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.subkey(purpose), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  private subkey(purpose: string): Buffer {
    return Buffer.from(hkdfSync('sha256', this.master, Buffer.alloc(0), purpose, 32));
  }
}

function loadMasterKey(): Buffer {
  const hex = process.env.FIELD_ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'FIELD_ENCRYPTION_KEY must be set to 32 random bytes as hex ' +
        "(generate: node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\")",
    );
  }
  return Buffer.from(hex, 'hex');
}

@Global()
@Module({
  providers: [
    { provide: 'FIELD_CRYPTO_MASTER_KEY', useFactory: loadMasterKey },
    FieldCrypto,
    PasswordService,
  ],
  exports: [FieldCrypto, PasswordService],
})
export class CryptoModule {}
