import { describe, it, expect } from 'vitest';
import { PasswordService } from '../../src/modules/auth/password.service';
import { TotpService } from '../../src/modules/auth/totp.service';
import { TokenService } from '../../src/modules/auth/token.service';
import { MemoryCacheService } from '../../src/infra/cache/memory-cache';

describe('Auth & Security Services', () => {
  const passwordService = new PasswordService();
  const totpService = new TotpService();
  const cacheService = new MemoryCacheService();
  const tokenService = new TokenService(cacheService);

  describe('Argon2 Password Hashing', () => {
    it('should hash passwords and verify matching candidate', async () => {
      const password = 'SuperSecurePassword123!';
      const hash = await passwordService.hashPassword(password);

      expect(hash).toContain('$argon2id$');
      const isMatch = await passwordService.verifyPassword(hash, password);
      expect(isMatch).toBe(true);

      const isNotMatch = await passwordService.verifyPassword(hash, 'WrongPassword');
      expect(isNotMatch).toBe(false);
    });
  });

  describe('TOTP Multi-Factor Authentication (RFC 6238)', () => {
    it('should generate valid TOTP secret and verify valid token', async () => {
      const setup = await totpService.generateSecret('patient@example.com');
      expect(setup.secret).toBeDefined();
      expect(setup.otpauthUrl).toContain('otpauth://totp/');
      expect(setup.qrCodeDataUrl).toContain('data:image/png;base64');

      // Generate a valid current token using speakeasy
      const speakeasy = (await import('speakeasy')).default;
      const validCode = speakeasy.totp({
        secret: setup.secret,
        encoding: 'base32'
      });

      const isValid = totpService.verifyToken(setup.secret, validCode);
      expect(isValid).toBe(true);

      const isInvalid = totpService.verifyToken(setup.secret, '000000');
      expect(isInvalid).toBe(false);
    });
  });

  describe('JWT Access & Rotating Refresh Tokens', () => {
    it('should issue tokens and rotate refresh token', async () => {
      const user = { id: 'u123', email: 'doc@example.com', role: 'doctor' as const };
      const tokens = await tokenService.generateTokenPair(user);

      expect(tokens.accessToken).toBeDefined();
      expect(tokens.refreshToken).toBeDefined();

      const decoded = tokenService.verifyAccessToken(tokens.accessToken);
      expect(decoded.userId).toBe('u123');
      expect(decoded.role).toBe('doctor');

      // Rotate refresh token
      const rotated = await tokenService.rotateRefreshToken(tokens.refreshToken);
      expect(rotated.accessToken).toBeDefined();
      expect(rotated.refreshToken).not.toBe(tokens.refreshToken);

      // Attempting to reuse old refresh token should trigger theft alert and fail
      await expect(tokenService.rotateRefreshToken(tokens.refreshToken)).rejects.toThrow(
        /Token reuse detected/
      );
    });
  });
});
