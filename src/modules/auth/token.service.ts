import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../../config/env';
import { UserRole } from '../../infra/db/database.interface';
import { ICacheService } from '../../infra/cache/cache.interface';
import { logger } from '../../infra/observability/logger';

export interface TokenPayload {
  userId: string;
  email: string;
  role: UserRole;
  familyId?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export class TokenService {
  constructor(private cacheService: ICacheService) {}

  /**
   * Issues an access token (15m) and a rotating refresh token (7d)
   */
  async generateTokenPair(user: { id: string; email: string; role: UserRole }, familyId?: string): Promise<TokenPair> {
    const currentFamilyId = familyId || crypto.randomUUID();
    const refreshId = crypto.randomUUID();

    const accessPayload: TokenPayload = {
      userId: user.id,
      email: user.email,
      role: user.role
    };

    const accessToken = jwt.sign(accessPayload, config.JWT_ACCESS_SECRET, {
      expiresIn: config.JWT_ACCESS_EXPIRATION as any
    });

    const refreshPayload: TokenPayload = {
      userId: user.id,
      email: user.email,
      role: user.role,
      familyId: currentFamilyId
    };

    const refreshToken = jwt.sign(refreshPayload, config.JWT_REFRESH_SECRET, {
      expiresIn: config.JWT_REFRESH_EXPIRATION as any,
      jwtid: refreshId
    });

    // Store the valid refresh token hash in cache with 7d TTL
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const cacheKey = `refresh_token:${user.id}:${currentFamilyId}`;
    await this.cacheService.set(cacheKey, tokenHash, 7 * 24 * 3600);

    return {
      accessToken,
      refreshToken,
      expiresIn: 15 * 60
    };
  }

  verifyAccessToken(token: string): TokenPayload {
    return jwt.verify(token, config.JWT_ACCESS_SECRET) as TokenPayload;
  }

  /**
   * Rotates a refresh token.
   * If an old/reused refresh token is presented, invalidates the entire family session (theft protection).
   */
  async rotateRefreshToken(refreshToken: string): Promise<TokenPair> {
    let decoded: any;
    try {
      decoded = jwt.verify(refreshToken, config.JWT_REFRESH_SECRET);
    } catch {
      throw new Error('Invalid or expired refresh token');
    }

    const { userId, email, role, familyId } = decoded as TokenPayload;
    if (!familyId) {
      throw new Error('Malformed refresh token');
    }

    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const cacheKey = `refresh_token:${userId}:${familyId}`;
    const storedHash = await this.cacheService.get<string>(cacheKey);

    if (!storedHash) {
      // Token not found or expired
      throw new Error('Refresh token has expired or was revoked');
    }

    if (storedHash !== tokenHash) {
      // REUSE DETECTED! Potential token theft. Invalidate family immediately.
      logger.warn({ userId, familyId }, 'Refresh token reuse detected! Revoking token family');
      await this.cacheService.del(cacheKey);
      throw new Error('Security alert: Token reuse detected. Please log in again.');
    }

    // Valid rotation: issue new token pair preserving the familyId
    return await this.generateTokenPair({ id: userId, email, role }, familyId);
  }

  async revokeSession(userId: string, familyId: string): Promise<void> {
    await this.cacheService.del(`refresh_token:${userId}:${familyId}`);
  }
}
