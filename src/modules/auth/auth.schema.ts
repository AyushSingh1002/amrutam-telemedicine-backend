import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters long'),
  role: z.enum(['patient', 'doctor', 'admin']),
  fullName: z.string().min(2),
  phone: z.string().optional(),
  dateOfBirth: z.string().optional(),
  // Doctor-specific fields
  specialty: z.string().optional(),
  licenseNumber: z.string().optional(),
  languages: z.array(z.string()).optional()
}).refine(
  (data) => {
    if (data.role === 'doctor') {
      return !!data.specialty && !!data.licenseNumber;
    }
    return true;
  },
  {
    message: 'Doctor registration requires specialty and licenseNumber',
    path: ['specialty']
  }
);

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totpCode: z.string().optional()
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1)
});

export const mfaVerifySchema = z.object({
  token: z.string().length(6, 'TOTP code must be 6 digits')
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;
export type MfaVerifyInput = z.infer<typeof mfaVerifySchema>;
