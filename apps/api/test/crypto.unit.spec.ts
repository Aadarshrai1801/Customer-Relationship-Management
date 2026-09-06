import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FieldCrypto } from '../src/crypto/crypto.module';

const MASTER_HEX = randomBytes(32).toString('hex');
const OTHER_HEX = randomBytes(32).toString('hex');

function cryptoWith(hex: string): FieldCrypto {
  return new FieldCrypto(Buffer.from(hex, 'hex'));
}

describe('FieldCrypto (AES-256-GCM + HKDF subkeys)', () => {
  it('round-trips plaintext for the same purpose', () => {
    const crypto = cryptoWith(MASTER_HEX);
    const encrypted = crypto.encrypt('totp-secret-value', '2fa-secret-v1');
    expect(encrypted).not.toContain('totp-secret-value');
    expect(encrypted.startsWith('gcm1.')).toBe(true);
    expect(crypto.decrypt(encrypted, '2fa-secret-v1')).toBe('totp-secret-value');
  });

  it('rejects decryption with the wrong purpose (domain separation)', () => {
    const crypto = cryptoWith(MASTER_HEX);
    const encrypted = crypto.encrypt('data', '2fa-secret-v1');
    expect(() => crypto.decrypt(encrypted, '2fa-codes-v1')).toThrow();
  });

  it('rejects decryption with a different master key', () => {
    const encrypted = cryptoWith(MASTER_HEX).encrypt('data', '2fa-secret-v1');
    expect(() => cryptoWith(OTHER_HEX).decrypt(encrypted, '2fa-secret-v1')).toThrow();
  });

  it('detects tampering with the ciphertext', () => {
    const crypto = cryptoWith(MASTER_HEX);
    const encrypted = crypto.encrypt('data', '2fa-secret-v1');
    const raw = Buffer.from(encrypted.slice('gcm1.'.length), 'base64');
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff;
    const tampered = `gcm1.${raw.toString('base64')}`;
    expect(() => crypto.decrypt(tampered, '2fa-secret-v1')).toThrow();
  });

  it('rejects malformed payloads', () => {
    const crypto = cryptoWith(MASTER_HEX);
    expect(() => crypto.decrypt('not-a-payload', '2fa-secret-v1')).toThrow();
    expect(() => crypto.decrypt('gcm1.eA==', '2fa-secret-v1')).toThrow();
  });
});
