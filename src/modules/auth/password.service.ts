import { hash, verify, Version, Algorithm } from '@node-rs/argon2';

export class PasswordService {
  /**
   * Hashes a password using Argon2id with recommended memory and time cost parameters
   */
  async hashPassword(password: string): Promise<string> {
    return await hash(password, {
      algorithm: Algorithm.Argon2id,
      memoryCost: 65536, // 64 MB
      timeCost: 3,       // 3 iterations
      parallelism: 4
    });
  }

  /**
   * Verifies a candidate password against an Argon2id hash
   */
  async verifyPassword(hashString: string, candidate: string): Promise<boolean> {
    try {
      return await verify(hashString, candidate);
    } catch {
      return false;
    }
  }
}

export const passwordService = new PasswordService();
