import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp, AppContainer } from '../../src/app';
import { InMemoryDatabase } from '../../src/infra/db/in-memory-db';
import { MockPaymentProvider } from '../../src/infra/providers/mock-payment';
import { MemoryCacheService } from '../../src/infra/cache/memory-cache';
import { MemoryQueueService } from '../../src/infra/queue/memory-queue';
import crypto from 'crypto';

describe('Booking Concurrency, Idempotency & Saga Rollback Integration Tests', () => {
  let app: FastifyInstance;
  let db: InMemoryDatabase;
  let paymentProvider: MockPaymentProvider;
  let cache: MemoryCacheService;
  let queue: MemoryQueueService;

  let patientToken: string;
  let patientId: string;
  let doctorId: string;
  let slotId: string;

  beforeEach(async () => {
    db = new InMemoryDatabase();
    paymentProvider = new MockPaymentProvider();
    cache = new MemoryCacheService();
    queue = new MemoryQueueService();

    app = await buildApp({
      db,
      paymentProvider,
      cache,
      queue
    });
    await app.ready();

    // 1. Register a doctor
    const docRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: `dr.${Date.now()}@amrutam.health`,
        password: 'DoctorPassword123!',
        role: 'doctor',
        fullName: 'Dr. Concurrency Tester',
        specialty: 'Ayurveda',
        licenseNumber: 'LIC-CONC-99'
      }
    });
    const docBody = JSON.parse(docRes.payload);
    doctorId = docBody.user.id;

    // 2. Doctor publishes a single open slot
    const slotRes = await app.inject({
      method: 'POST',
      url: `/api/v1/doctors/${doctorId}/slots`,
      headers: {
        authorization: `Bearer ${docBody.tokens.accessToken}`
      },
      payload: {
        startTime: '2026-10-15T09:00:00.000Z',
        endTime: '2026-10-15T09:30:00.000Z'
      }
    });
    const slotBody = JSON.parse(slotRes.payload);
    slotId = slotBody.id;

    // 3. Register a patient
    const patRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: `patient.${Date.now()}@example.com`,
        password: 'PatientPassword123!',
        role: 'patient',
        fullName: 'Patient One'
      }
    });
    const patBody = JSON.parse(patRes.payload);
    patientId = patBody.user.id;
    patientToken = patBody.tokens.accessToken;
  });

  afterEach(async () => {
    await app.close();
  });

  it('CONCURRENCY RACE: 15 simultaneous booking requests against the same slot should yield exactly 1 winner and 14 conflicts (ZERO double booking)', async () => {
    // Generate 15 distinct patients and requests
    const concurrentRequests = Array.from({ length: 15 }).map(async (_, idx) => {
      const idemKey = `concurrency-test-key-${idx}-${crypto.randomUUID()}`;
      return await app.inject({
        method: 'POST',
        url: '/api/v1/booking/reserve',
        headers: {
          authorization: `Bearer ${patientToken}`,
          'idempotency-key': idemKey
        },
        payload: {
          slotId,
          amountCents: 50000
        }
      });
    });

    const responses = await Promise.all(concurrentRequests);

    const successResponses = responses.filter((r) => r.statusCode === 201);
    const conflictResponses = responses.filter((r) => r.statusCode === 409);

    expect(successResponses.length).toBe(1);
    expect(conflictResponses.length).toBe(14);

    const winnerBody = JSON.parse(successResponses[0].payload);
    expect(winnerBody.slotId).toBe(slotId);
    expect(winnerBody.status).toBe('scheduled');

    const conflictBody = JSON.parse(conflictResponses[0].payload);
    expect(conflictBody.error.code).toBe('SLOT_UNAVAILABLE');
  });

  it('IDEMPOTENCY: Re-sending identical booking request returns cached response without duplicate action', async () => {
    const fixedIdemKey = `idem-fixed-${crypto.randomUUID()}`;

    // First request
    const firstRes = await app.inject({
      method: 'POST',
      url: '/api/v1/booking/reserve',
      headers: {
        authorization: `Bearer ${patientToken}`,
        'idempotency-key': fixedIdemKey
      },
      payload: {
        slotId,
        amountCents: 50000
      }
    });

    expect(firstRes.statusCode).toBe(201);
    const firstBody = JSON.parse(firstRes.payload);

    // Second request with SAME idempotency key
    const secondRes = await app.inject({
      method: 'POST',
      url: '/api/v1/booking/reserve',
      headers: {
        authorization: `Bearer ${patientToken}`,
        'idempotency-key': fixedIdemKey
      },
      payload: {
        slotId,
        amountCents: 50000
      }
    });

    expect(secondRes.statusCode).toBe(201);
    expect(secondRes.headers['x-idempotent-replayed']).toBe('true');
    const secondBody = JSON.parse(secondRes.payload);
    expect(secondBody.consultationId).toBe(firstBody.consultationId);
  });

  it('SAGA COMPENSATING ROLLBACK: Payment failure immediately releases held slot back to open', async () => {
    const idemKeyReserve = `saga-reserve-${crypto.randomUUID()}`;

    // Step 1: Reserve slot
    const reserveRes = await app.inject({
      method: 'POST',
      url: '/api/v1/booking/reserve',
      headers: {
        authorization: `Bearer ${patientToken}`,
        'idempotency-key': idemKeyReserve
      },
      payload: {
        slotId,
        amountCents: 50000
      }
    });
    expect(reserveRes.statusCode).toBe(201);
    const { consultationId } = JSON.parse(reserveRes.payload);

    // Check slot is held
    let slot = await db.slots.findById(slotId);
    expect(slot?.status).toBe('held');

    // Step 2: Confirm with simulated payment failure
    const idemKeyConfirm = `saga-confirm-${crypto.randomUUID()}`;
    const confirmRes = await app.inject({
      method: 'POST',
      url: '/api/v1/booking/confirm',
      headers: {
        authorization: `Bearer ${patientToken}`,
        'idempotency-key': idemKeyConfirm
      },
      payload: {
        consultationId,
        paymentSuccess: false,
        forceFail: true
      }
    });

    expect(confirmRes.statusCode).toBe(402);
    const failBody = JSON.parse(confirmRes.payload);
    expect(failBody.error.code).toBe('PAYMENT_FAILED');

    // COMPENSATING ACTION VERIFICATION: Slot must be open again!
    slot = await db.slots.findById(slotId);
    expect(slot?.status).toBe('open');

    // Consultation must be marked cancelled
    const consultation = await db.consultations.findById(consultationId);
    expect(consultation?.status).toBe('cancelled');

    // Another patient can now successfully reserve this released slot!
    const retryRes = await app.inject({
      method: 'POST',
      url: '/api/v1/booking/reserve',
      headers: {
        authorization: `Bearer ${patientToken}`,
        'idempotency-key': `saga-retry-${crypto.randomUUID()}`
      },
      payload: {
        slotId,
        amountCents: 50000
      }
    });
    expect(retryRes.statusCode).toBe(201);
  });
});
