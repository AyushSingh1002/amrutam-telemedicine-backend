import fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import crypto from 'crypto';

import { config } from './config/env';
import { logger } from './infra/observability/logger';
import {
  httpRequestDurationMicroseconds,
  httpRequestsTotal,
  getMetrics,
  getMetricsContentType
} from './infra/observability/metrics';
import { errorHandler } from './middleware/error-handler';

import { IDatabase } from './infra/db/database.interface';
import { InMemoryDatabase } from './infra/db/in-memory-db';
import { ICacheService } from './infra/cache/cache.interface';
import { MemoryCacheService } from './infra/cache/memory-cache';
import { RedisCacheService } from './infra/cache/redis-cache';
import { IQueueService } from './infra/queue/queue.interface';
import { MemoryQueueService } from './infra/queue/memory-queue';
import { BullMQQueueService } from './infra/queue/bullmq-queue';
import { IPaymentProvider } from './infra/providers/payment.interface';
import { MockPaymentProvider } from './infra/providers/mock-payment';
import { INotificationProvider } from './infra/providers/notification.interface';
import { ConsoleNotificationProvider } from './infra/providers/console-notification';

import { PasswordService } from './modules/auth/password.service';
import { TokenService } from './modules/auth/token.service';
import { TotpService } from './modules/auth/totp.service';
import { AuthService } from './modules/auth/auth.service';
import { createAuthRoutes } from './modules/auth/auth.controller';

import { AuditService } from './modules/audit/audit.service';
import { CryptoService } from './modules/prescriptions/crypto.service';

import { DoctorsService } from './modules/doctors/doctors.service';
import { createDoctorRoutes } from './modules/doctors/doctors.controller';

import { SearchService } from './modules/search/search.service';
import { createSearchRoutes } from './modules/search/search.controller';

import { BookingService } from './modules/booking/booking.service';
import { createBookingRoutes } from './modules/booking/booking.controller';

import { ConsultationsService } from './modules/consultations/consultations.service';
import { createConsultationRoutes } from './modules/consultations/consultations.controller';

import { PrescriptionsService } from './modules/prescriptions/prescriptions.service';
import { createPrescriptionRoutes } from './modules/prescriptions/prescriptions.controller';

import { AdminService } from './modules/admin/admin.service';
import { createAdminRoutes } from './modules/admin/admin.controller';

import { setupNotificationWorker } from './jobs/notification.job';
import { setupReminderWorker } from './jobs/reminder.job';
import { setupAnalyticsRollupWorker } from './jobs/analytics-rollup.job';

export interface AppContainer {
  db: IDatabase;
  cache: ICacheService;
  queue: IQueueService;
  paymentProvider: IPaymentProvider;
  notificationProvider: INotificationProvider;
  passwordService?: PasswordService;
  tokenService?: TokenService;
  totpService?: TotpService;
  auditService?: AuditService;
  cryptoService?: CryptoService;
}

export function buildContainer(overrides?: Partial<AppContainer>): AppContainer {
  const db = overrides?.db || new InMemoryDatabase();
  const cache = overrides?.cache || (config.NODE_ENV === 'production' ? new RedisCacheService(config.REDIS_URL) : new MemoryCacheService());
  const queue = overrides?.queue || (config.NODE_ENV === 'production' ? new BullMQQueueService(config.REDIS_URL) : new MemoryQueueService());
  const paymentProvider = overrides?.paymentProvider || new MockPaymentProvider();
  const notificationProvider = overrides?.notificationProvider || new ConsoleNotificationProvider();

  const passwordService = overrides?.passwordService || new PasswordService();
  const tokenService = overrides?.tokenService || new TokenService(cache);
  const totpService = overrides?.totpService || new TotpService();
  const auditService = overrides?.auditService || new AuditService(db);
  const cryptoService = overrides?.cryptoService || new CryptoService(config.ENCRYPTION_KEY);

  return {
    db,
    cache,
    queue,
    paymentProvider,
    notificationProvider,
    passwordService,
    tokenService,
    totpService,
    auditService,
    cryptoService
  };
}

export async function buildApp(containerOverrides?: Partial<AppContainer>): Promise<FastifyInstance> {
  const app = fastify({
    logger: false,
    genReqId: () => crypto.randomUUID()
  });

  const container = buildContainer(containerOverrides);

  // Background workers setup
  setupNotificationWorker(container.queue, container.notificationProvider);
  setupReminderWorker(container.queue, container.notificationProvider);
  setupAnalyticsRollupWorker(container.queue, container.db, container.cache);

  // Security Middleware
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"]
      }
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true
    }
  });

  await app.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id']
  });

  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS
  });

  // Observability & Metrics Hook
  app.addHook('onRequest', async (request, reply) => {
    (request as any).startTime = process.hrtime();
    const correlationId = (request.headers['x-request-id'] as string) || request.id;
    reply.header('X-Request-Id', correlationId);
  });

  app.addHook('onResponse', async (request, reply) => {
    const startTime = (request as any).startTime;
    if (startTime) {
      const diff = process.hrtime(startTime);
      const durationSeconds = diff[0] + diff[1] / 1e9;
      const route = request.routeOptions?.url || request.url;
      const statusCode = reply.statusCode.toString();

      httpRequestDurationMicroseconds.observe(
        { method: request.method, route, status_code: statusCode },
        durationSeconds
      );
      httpRequestsTotal.inc({ method: request.method, route, status_code: statusCode });
    }
  });

  // Centralized Error Handler
  app.setErrorHandler(errorHandler);

  // Health and System Endpoints
  app.get('/healthz', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: config.OTEL_SERVICE_NAME
  }));

  app.get('/readyz', async (_request, reply) => {
    const dbReady = await container.db.ping();
    const cacheReady = await container.cache.ping();

    if (dbReady && cacheReady) {
      return reply.status(200).send({
        status: 'ready',
        database: 'healthy',
        cache: 'healthy'
      });
    }

    return reply.status(503).send({
      status: 'unavailable',
      database: dbReady ? 'healthy' : 'degraded',
      cache: cacheReady ? 'healthy' : 'degraded'
    });
  });

  app.get('/metrics', async (_request, reply) => {
    const metrics = await getMetrics();
    reply.header('Content-Type', getMetricsContentType());
    return reply.send(metrics);
  });

  // Instantiate Module Services
  const authService = new AuthService(
    container.db,
    container.passwordService!,
    container.tokenService!,
    container.totpService!,
    container.auditService!
  );

  const doctorsService = new DoctorsService(container.db, container.cache, container.auditService!);
  const searchService = new SearchService(container.db, container.cache);
  const bookingService = new BookingService(
    container.db,
    container.paymentProvider,
    container.queue,
    container.cache,
    container.auditService!
  );
  const consultationsService = new ConsultationsService(container.db, container.auditService!);
  const prescriptionsService = new PrescriptionsService(
    container.db,
    container.cryptoService!,
    container.auditService!
  );
  const adminService = new AdminService(container.db, container.cache, container.auditService!);

  // Register API Routes
  await app.register(createAuthRoutes(authService, container.tokenService!), { prefix: '/api/v1/auth' });
  await app.register(createDoctorRoutes(doctorsService, container.tokenService!), { prefix: '/api/v1/doctors' });
  await app.register(createSearchRoutes(searchService), { prefix: '/api/v1/search' });
  await app.register(createBookingRoutes(bookingService, container.tokenService!, container.db), {
    prefix: '/api/v1/booking'
  });
  await app.register(createConsultationRoutes(consultationsService, container.tokenService!), {
    prefix: '/api/v1/consultations'
  });
  await app.register(createPrescriptionRoutes(prescriptionsService, container.tokenService!), {
    prefix: '/api/v1/consultations'
  });
  await app.register(createAdminRoutes(adminService, container.tokenService!), { prefix: '/api/v1/admin' });

  // Decorate app with container for programmatic inspection in tests
  app.decorate('container', container);

  return app;
}
