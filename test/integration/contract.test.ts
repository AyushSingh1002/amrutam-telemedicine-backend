import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app';

describe('OpenAPI Contract Verification Suite', () => {
  let app: FastifyInstance;
  let openApiContent: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    const openApiPath = path.resolve(__dirname, '../../docs/openapi.yaml');
    openApiContent = fs.readFileSync(openApiPath, 'utf8');
  });

  afterAll(async () => {
    await app.close();
  });

  it('should include all required production endpoints in openapi.yaml', () => {
    const requiredEndpoints = [
      '/healthz',
      '/readyz',
      '/metrics',
      '/api/v1/auth/register',
      '/api/v1/auth/login',
      '/api/v1/auth/refresh',
      '/api/v1/auth/mfa/setup',
      '/api/v1/auth/mfa/verify',
      '/api/v1/search/doctors',
      '/api/v1/doctors/{doctorId}/slots',
      '/api/v1/booking/reserve',
      '/api/v1/booking/confirm',
      '/api/v1/consultations',
      '/api/v1/consultations/{consultationId}',
      '/api/v1/consultations/{consultationId}/status',
      '/api/v1/consultations/{consultationId}/prescription',
      '/api/v1/admin/analytics',
      '/api/v1/admin/audit-logs'
    ];

    for (const endpoint of requiredEndpoints) {
      expect(openApiContent).toContain(endpoint);
    }
  });

  it('health endpoints should respond with contract-compliant schemas', async () => {
    const healthz = await app.inject({ method: 'GET', url: '/healthz' });
    expect(healthz.statusCode).toBe(200);
    const body = JSON.parse(healthz.payload);
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();

    const readyz = await app.inject({ method: 'GET', url: '/readyz' });
    expect(readyz.statusCode).toBe(200);
    const readyBody = JSON.parse(readyz.payload);
    expect(readyBody.status).toBe('ready');

    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers['content-type']).toContain('text/plain');
    expect(metrics.payload).toContain('amrutam_http_requests_total');
  });
});
