import { describe, it, expect } from 'vitest';
import { CryptoService } from '../../src/modules/prescriptions/crypto.service';

describe('CryptoService (AES-256-GCM Encryption)', () => {
  const cryptoService = new CryptoService('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');

  it('should successfully encrypt and decrypt clinical notes', () => {
    const sensitiveClinicalNote = 'Patient diagnosed with acute seasonal allergic rhinitis. Prescribe Cetirizine 10mg.';
    const encryptedBuffer = cryptoService.encrypt(sensitiveClinicalNote);

    expect(encryptedBuffer).toBeInstanceOf(Buffer);
    expect(encryptedBuffer.length).toBeGreaterThan(sensitiveClinicalNote.length);

    const decrypted = cryptoService.decrypt(encryptedBuffer);
    expect(decrypted).toBe(sensitiveClinicalNote);
  });

  it('should detect tampering and fail decryption with authentication tag error', () => {
    const note = 'Confidential psychiatric assessment notes';
    const encryptedBuffer = cryptoService.encrypt(note);

    // Tamper with the ciphertext (last byte)
    encryptedBuffer[encryptedBuffer.length - 1] ^= 0xff;

    expect(() => {
      cryptoService.decrypt(encryptedBuffer);
    }).toThrow();
  });

  it('should reject invalid key length', () => {
    expect(() => {
      new CryptoService('short_key');
    }).toThrow(/ENCRYPTION_KEY must be exactly 32 bytes/);
  });
});
