import pino from 'pino';
import { config } from '../../config/env';

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'passwordHash',
      'mfaSecret',
      'notesEncrypted',
      'token',
      'refreshToken'
    ],
    censor: '[REDACTED]'
  },
  transport: config.NODE_ENV === 'development'
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
          ignore: 'pid,hostname'
        }
      }
    : undefined,
  base: {
    service: config.OTEL_SERVICE_NAME,
    env: config.NODE_ENV
  }
});
