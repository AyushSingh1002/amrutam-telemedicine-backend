import { IDatabase, UserEntity } from '../../infra/db/database.interface';
import { PasswordService } from './password.service';
import { TokenService, TokenPair } from './token.service';
import { TotpService, MfaSetupResult } from './totp.service';
import { AuditService } from '../audit/audit.service';
import { RegisterInput, LoginInput } from './auth.schema';

export interface AuthResponse {
  user: {
    id: string;
    email: string;
    role: string;
    fullName: string;
    mfaEnabled: boolean;
  };
  tokens?: TokenPair;
  mfaRequired?: boolean;
}

export class AuthService {
  constructor(
    private db: IDatabase,
    private passwordService: PasswordService,
    private tokenService: TokenService,
    private totpService: TotpService,
    private auditService: AuditService
  ) {}

  async register(input: RegisterInput): Promise<AuthResponse> {
    const existing = await this.db.users.findByEmail(input.email);
    if (existing) {
      throw { statusCode: 409, code: 'EMAIL_EXISTS', message: 'Email is already registered' };
    }

    const passwordHash = await this.passwordService.hashPassword(input.password);

    const user = await this.db.users.create({
      email: input.email,
      passwordHash,
      role: input.role,
      profile: {
        fullName: input.fullName,
        phone: input.phone,
        dateOfBirth: input.dateOfBirth
      },
      doctor:
        input.role === 'doctor' && input.specialty && input.licenseNumber
          ? {
              specialty: input.specialty,
              licenseNumber: input.licenseNumber,
              languages: input.languages || []
            }
          : undefined
    });

    await this.auditService.record({
      actorId: user.id,
      action: 'USER_REGISTERED',
      entityType: 'User',
      entityId: user.id,
      after: { email: user.email, role: user.role }
    });

    const tokens = await this.tokenService.generateTokenPair({
      id: user.id,
      email: user.email,
      role: user.role
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        fullName: user.profile?.fullName || '',
        mfaEnabled: user.mfaEnabled
      },
      tokens
    };
  }

  async login(input: LoginInput): Promise<AuthResponse> {
    const user = await this.db.users.findByEmail(input.email);
    if (!user) {
      throw { statusCode: 401, code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' };
    }

    const isValidPassword = await this.passwordService.verifyPassword(user.passwordHash, input.password);
    if (!isValidPassword) {
      await this.auditService.record({
        actorId: user.id,
        action: 'FAILED_LOGIN_ATTEMPT',
        entityType: 'User',
        entityId: user.id
      });
      throw { statusCode: 401, code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' };
    }

    // Check TOTP MFA if enabled
    if (user.mfaEnabled) {
      if (!input.totpCode) {
        return {
          user: {
            id: user.id,
            email: user.email,
            role: user.role,
            fullName: user.profile?.fullName || '',
            mfaEnabled: true
          },
          mfaRequired: true
        };
      }

      if (!user.mfaSecret || !this.totpService.verifyToken(user.mfaSecret, input.totpCode)) {
        await this.auditService.record({
          actorId: user.id,
          action: 'FAILED_MFA_ATTEMPT',
          entityType: 'User',
          entityId: user.id
        });
        throw { statusCode: 401, code: 'INVALID_MFA_CODE', message: 'Invalid or expired 6-digit TOTP code' };
      }
    }

    const tokens = await this.tokenService.generateTokenPair({
      id: user.id,
      email: user.email,
      role: user.role
    });

    await this.auditService.record({
      actorId: user.id,
      action: 'USER_LOGIN',
      entityType: 'User',
      entityId: user.id
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        fullName: user.profile?.fullName || '',
        mfaEnabled: user.mfaEnabled
      },
      tokens
    };
  }

  async refreshToken(token: string): Promise<TokenPair> {
    return await this.tokenService.rotateRefreshToken(token);
  }

  async setupMfa(userId: string): Promise<MfaSetupResult> {
    const user = await this.db.users.findById(userId);
    if (!user) {
      throw { statusCode: 404, code: 'USER_NOT_FOUND', message: 'User not found' };
    }

    const mfa = await this.totpService.generateSecret(user.email);
    // Temporarily save secret awaiting confirmation
    await this.db.users.updateMfa(userId, mfa.secret, false);

    return mfa;
  }

  async verifyAndEnableMfa(userId: string, code: string): Promise<void> {
    const user = await this.db.users.findById(userId);
    if (!user || !user.mfaSecret) {
      throw { statusCode: 400, code: 'MFA_NOT_INITIALIZED', message: 'MFA setup has not been initiated' };
    }

    const isValid = this.totpService.verifyToken(user.mfaSecret, code);
    if (!isValid) {
      throw { statusCode: 400, code: 'INVALID_MFA_TOKEN', message: 'Verification code is invalid or expired' };
    }

    await this.db.users.updateMfa(userId, user.mfaSecret, true);

    await this.auditService.record({
      actorId: userId,
      action: 'MFA_ACTIVATED',
      entityType: 'User',
      entityId: userId
    });
  }
}
