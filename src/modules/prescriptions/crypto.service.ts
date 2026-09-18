import crypto from 'crypto';
import { config } from '../../config/env';

export class CryptoService {
  private key: Buffer;
  private readonly ALGORITHM = 'aes-256-gcm';
  private readonly IV_LENGTH = 12; // Standard 96 bits for GCM
  private readonly TAG_LENGTH = 16; // Standard 128 bits auth tag

  constructor(encryptionKeyHex?: string) {
    const hexKey = encryptionKeyHex || config.ENCRYPTION_KEY;
    this.key = Buffer.from(hexKey, 'hex');
    if (this.key.length !== 32) {
      throw new Error('ENCRYPTION_KEY must be exactly 32 bytes (64 hex characters) for AES-256-GCM');
    }
  }

  /**
   * Encrypts plaintext string into an authenticated AES-256-GCM buffer:
   * Format: [12-byte IV] + [16-byte AuthTag] + [Ciphertext]
   */
  encrypt(plaintext: string): Buffer {
    const iv = crypto.randomBytes(this.IV_LENGTH);
    const cipher = crypto.createCipheriv(this.ALGORITHM, this.key, iv);

    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final()
    ]);
    const authTag = cipher.getAuthTag();

    return Buffer.concat([iv, authTag, ciphertext]);
  }

  /**
   * Decrypts an authenticated AES-256-GCM buffer into plaintext string.
   * Throws an error if authentication tag verification fails (tampering detected).
   */
  decrypt(encryptedBuffer: Buffer): string {
    if (encryptedBuffer.length < this.IV_LENGTH + this.TAG_LENGTH) {
      throw new Error('Invalid encrypted buffer format');
    }

    const iv = encryptedBuffer.subarray(0, this.IV_LENGTH);
    const authTag = encryptedBuffer.subarray(this.IV_LENGTH, this.IV_LENGTH + this.TAG_LENGTH);
    const ciphertext = encryptedBuffer.subarray(this.IV_LENGTH + this.TAG_LENGTH);

    const decipher = crypto.createDecipheriv(this.ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);

    return decrypted.toString('utf8');
  }
}

export const cryptoService = new CryptoService();
