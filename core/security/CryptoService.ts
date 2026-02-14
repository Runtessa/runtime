import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

export interface EncryptedPayload {
  iv: string;
  authTag: string;
  encryptedValue: string;
}

export interface TokenPayload {
  sub: string;
  tenantId: string;
  role?: string;
  exp: number;
  metadata?: Record<string, unknown>;
}

export class CryptoService {
  private readonly encryptionKey: Buffer;
  private readonly tokenSecret: Buffer;

  constructor(encryptionKey: Buffer, tokenSecret: Buffer) {
    if (encryptionKey.length !== 32) {
      throw new Error('Encryption key must be 32 bytes for AES-256-GCM');
    }
    this.encryptionKey = encryptionKey;
    this.tokenSecret = tokenSecret;
  }

  async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
    return `${salt.toString('hex')}:${derivedKey.toString('hex')}`;
  }

  async comparePassword(password: string, storedHash: string): Promise<boolean> {
    const [saltHex, hashHex] = storedHash.split(':');
    if (!saltHex || !hashHex) {
      return false;
    }

    const salt = Buffer.from(saltHex, 'hex');
    const expectedHash = Buffer.from(hashHex, 'hex');
    const derivedKey = (await scryptAsync(password, salt, expectedHash.length)) as Buffer;

    if (expectedHash.length !== derivedKey.length) {
      return false;
    }

    return timingSafeEqual(expectedHash, derivedKey);
  }

  encryptSecret(value: string): EncryptedPayload {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
      encryptedValue: encrypted.toString('hex'),
    };
  }

  decryptSecret(payload: EncryptedPayload): string {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      Buffer.from(payload.iv, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(payload.authTag, 'hex'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payload.encryptedValue, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  // Backwards-compatible aliases (avoid breaking callers)
  encrypt(value: string): EncryptedPayload {
    return this.encryptSecret(value);
  }

  decrypt(payload: EncryptedPayload): string {
    return this.decryptSecret(payload);
  }

  signToken(payload: Omit<TokenPayload, 'exp'>, ttlSeconds: number): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const fullPayload: TokenPayload = { ...payload, exp };
    const serialized = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
    const signature = createHmac('sha256', this.tokenSecret).update(serialized).digest();
    return `${serialized}.${signature.toString('base64url')}`;
  }

  verifyToken(token: string): TokenPayload | null {
    const [payloadPart, signaturePart] = token.split('.');
    if (!payloadPart || !signaturePart) {
      return null;
    }

    const expected = createHmac('sha256', this.tokenSecret).update(payloadPart).digest();
    const received = Buffer.from(signaturePart, 'base64url');
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      return null;
    }

    try {
      const parsed = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as TokenPayload;
      if (parsed.exp <= Math.floor(Date.now() / 1000)) {
        return null;
      }
      return parsed;
    } catch (error) {
      return null;
    }
  }
}
