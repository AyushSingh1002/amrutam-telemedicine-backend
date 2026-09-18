import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import { config } from '../../config/env';

export interface MfaSetupResult {
  secret: string;
  otpauthUrl: string;
  qrCodeDataUrl: string;
}

export class TotpService {
  /**
   * Generates a new TOTP secret and data URL for QR code scanning
   */
  async generateSecret(userEmail: string): Promise<MfaSetupResult> {
    const secret = speakeasy.generateSecret({
      length: 20,
      name: `${config.TOTP_ISSUER}:${userEmail}`,
      issuer: config.TOTP_ISSUER
    });

    const otpauthUrl = secret.otpauth_url || '';
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

    return {
      secret: secret.base32,
      otpauthUrl,
      qrCodeDataUrl
    };
  }

  /**
   * Verifies a 6-digit TOTP code against the base32 secret
   * Allows 1 window step drift (±30 seconds) for clock skew
   */
  verifyToken(secret: string, token: string): boolean {
    return speakeasy.totp.verify({
      secret,
      encoding: 'base32',
      token: token.trim(),
      window: 1
    });
  }
}

export const totpService = new TotpService();
