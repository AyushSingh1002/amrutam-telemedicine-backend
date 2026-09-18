import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  
  API_BASE_URL: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().default('postgresql://amrutam_user:amrutam_secure_pass@localhost:5432/amrutam_telemedicine?schema=public'),
  DB_POOL_MIN: z.coerce.number().default(5),
  DB_POOL_MAX: z.coerce.number().default(20),

  REDIS_URL: z.string().default('redis://localhost:6379'),
  REDIS_CACHE_TTL_SECONDS: z.coerce.number().default(60),

  JWT_ACCESS_SECRET: z.string().min(16).default('amrutam_jwt_super_secret_access_key_change_in_production_32chars'),
  JWT_REFRESH_SECRET: z.string().min(16).default('amrutam_jwt_super_secret_refresh_key_change_in_production_32chars'),
  JWT_ACCESS_EXPIRATION: z.string().default('15m'),
  JWT_REFRESH_EXPIRATION: z.string().default('7d'),
  TOTP_ISSUER: z.string().default('AmrutamTelemedicine'),

  // 32-byte hex encryption key (64 characters)
  ENCRYPTION_KEY: z.string().default('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),

  RATE_LIMIT_MAX: z.coerce.number().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().default(10),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),

  PROMETHEUS_METRICS_ENABLED: z.coerce.boolean().default(true),
  OTEL_SERVICE_NAME: z.string().default('amrutam-telemedicine-backend'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default('http://localhost:4318'),

  PAYMENT_PROVIDER_MODE: z.enum(['mock', 'live']).default('mock'),
  NOTIFICATION_PROVIDER_MODE: z.enum(['console', 'mock', 'live']).default('console'),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function loadConfig(overrides?: Partial<EnvConfig>): EnvConfig {
  const result = envSchema.safeParse({
    ...process.env,
    ...overrides,
  });

  if (!result.success) {
    console.error('Invalid environment configuration:', result.error.format());
    throw new Error('Environment configuration validation failed');
  }

  return result.data;
}

export const config = loadConfig();
