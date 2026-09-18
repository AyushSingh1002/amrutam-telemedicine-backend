import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app';
import { InMemoryDatabase } from '../../src/infra/db/in-memory-db';
import { MemoryCacheService } from '../../src/infra/cache/memory-cache';
import { MemoryQueueService } from '../../src/infra/queue/memory-queue';
import crypto from 'crypto';

describe('End-to-End API Workflows & RBAC Security Suite', () => {
  let app: FastifyInstance;
  let db: InMemoryDatabase;
  let cache: MemoryCacheService;
  let queue: MemoryQueueService;

  let patientToken: string;
  let patientId: string;
  let doctorToken: string;
  let doctorId: string;
  let adminToken: string;
  let adminId: string;

  beforeEach(async () => {
    db = new InMemoryDatabase();
    cache = new MemoryCacheService();
    queue = new MemoryQueueService();

    app = await buildApp({ db, cache, queue });
    await app.ready();

    // 1. Register Doctor
    const docRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'doctor.vaidya@amrutam.health',
        password: 'DoctorPassword123!',
        role: 'doctor',
        fullName: 'Dr. Vaidya Raman',
        specialty: 'Ayurveda',
        licenseNumber: 'AYU-IND-8832',
        languages: ['English', 'Hindi', 'Sanskrit']
      }
    });
    const docBody = JSON.parse(docRes.payload);
    doctorId = docBody.user.id;
    doctorToken = docBody.tokens.accessToken;

    // 2. Register Patient
    const patRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'patient.arun@example.com',
        password: 'PatientPassword123!',
        role: 'patient',
        fullName: 'Arun Kumar',
        phone: '+919876543210'
      }
    });
    const patBody = JSON.parse(patRes.payload);
    patientId = patBody.user.id;
    patientToken = patBody.tokens.accessToken;

    // 3. Register Admin
    const admRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'admin.ops@amrutam.health',
        password: 'AdminPassword123!',
        role: 'admin',
        fullName: 'Platform Administrator'
      }
    });
    const admBody = JSON.parse(admRes.payload);
    adminId = admBody.user.id;
    adminToken = admBody.tokens.accessToken;
  });

  afterEach(async () => {
    await app.close();
  });

  it('COMPLETE E2E FLOW: Slot Publish -> Search -> Booking -> Consult Lifecycle -> Encrypted Prescription -> Admin Analytics & Audit', async () => {
    // 1. Doctor publishes slot
    const slotRes = await app.inject({
      method: 'POST',
      url: `/api/v1/doctors/${doctorId}/slots`,
      headers: { authorization: `Bearer ${doctorToken}` },
      payload: {
        startTime: '2026-10-20T10:00:00.000Z',
        endTime: '2026-10-20T10:30:00.000Z'
      }
    });
    expect(slotRes.statusCode).toBe(201);
    const slot = JSON.parse(slotRes.payload);
    expect(slot.status).toBe('open');

    // 2. Patient searches doctors (Cache miss -> Cache hit)
    const searchRes1 = await app.inject({
      method: 'GET',
      url: '/api/v1/search/doctors?specialty=Ayurveda&language=Hindi'
    });
    expect(searchRes1.statusCode).toBe(200);
    const searchBody1 = JSON.parse(searchRes1.payload);
    expect(searchBody1.total).toBe(1);
    expect(searchBody1.cached).toBe(false);

    // Second search should be served from cache
    const searchRes2 = await app.inject({
      method: 'GET',
      url: '/api/v1/search/doctors?specialty=Ayurveda&language=Hindi'
    });
    const searchBody2 = JSON.parse(searchRes2.payload);
    expect(searchBody2.cached).toBe(true);

    // 3. Patient reserves slot (Idempotent)
    const reserveRes = await app.inject({
      method: 'POST',
      url: '/api/v1/booking/reserve',
      headers: {
        authorization: `Bearer ${patientToken}`,
        'idempotency-key': `flow-reserve-${crypto.randomUUID()}`
      },
      payload: {
        slotId: slot.id,
        amountCents: 75000
      }
    });
    expect(reserveRes.statusCode).toBe(201);
    const reserveBody = JSON.parse(reserveRes.payload);
    const consultationId = reserveBody.consultationId;
    expect(consultationId).toBeDefined();

    // 4. Patient confirms booking & payment
    const confirmRes = await app.inject({
      method: 'POST',
      url: '/api/v1/booking/confirm',
      headers: {
        authorization: `Bearer ${patientToken}`,
        'idempotency-key': `flow-confirm-${crypto.randomUUID()}`
      },
      payload: {
        consultationId,
        paymentSuccess: true
      }
    });
    expect(confirmRes.statusCode).toBe(200);
    const confirmBody = JSON.parse(confirmRes.payload);
    expect(confirmBody.paymentStatus).toBe('captured');

    // Verify confirmation notification was enqueued in BullMQ queue
    expect(queue.jobsEnqueued.some((j) => j.jobName === 'send-confirmation-email')).toBe(true);

    // 5. Doctor starts consultation (scheduled -> in_progress, version 1 -> 2)
    const startRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/consultations/${consultationId}/status`,
      headers: { authorization: `Bearer ${doctorToken}` },
      payload: {
        status: 'in_progress',
        expectedVersion: 1
      }
    });
    expect(startRes.statusCode).toBe(200);
    const startBody = JSON.parse(startRes.payload);
    expect(startBody.status).toBe('in_progress');
    expect(startBody.version).toBe(2);

    // 6. Doctor completes consultation (in_progress -> completed, version 2 -> 3)
    const completeRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/consultations/${consultationId}/status`,
      headers: { authorization: `Bearer ${doctorToken}` },
      payload: {
        status: 'completed',
        expectedVersion: 2
      }
    });
    expect(completeRes.statusCode).toBe(200);
    const completeBody = JSON.parse(completeRes.payload);
    expect(completeBody.status).toBe('completed');
    expect(completeBody.version).toBe(3);

    // 7. Doctor issues prescription with AES-256-GCM encrypted notes
    const rxRes = await app.inject({
      method: 'POST',
      url: `/api/v1/consultations/${consultationId}/prescription`,
      headers: { authorization: `Bearer ${doctorToken}` },
      payload: {
        clinicalNotes: 'Vata-Pitta imbalance diagnosed. Take Ashwagandha and Brahmi syrup before bed.',
        medications: [
          { name: 'Ashwagandha Churna', dosage: '5g', frequency: 'Twice daily', duration: '30 days' },
          { name: 'Brahmi Vati', dosage: '250mg', frequency: 'Once daily at bedtime', duration: '15 days' }
        ]
      }
    });
    expect(rxRes.statusCode).toBe(201);
    const rxBody = JSON.parse(rxRes.payload);
    expect(rxBody.medications.length).toBe(2);

    // Direct database check: clinical notes must be stored as raw encrypted bytes, never plain text!
    const rawRxInDb = await db.prescriptions.findByConsultation(consultationId);
    expect(rawRxInDb?.notesEncrypted).toBeInstanceOf(Buffer);
    expect(rawRxInDb?.notesEncrypted.toString('utf8')).not.toContain('Ashwagandha');

    // 8. Patient retrieves prescription (decrypted transparently)
    const patientRxRes = await app.inject({
      method: 'GET',
      url: `/api/v1/consultations/${consultationId}/prescription`,
      headers: { authorization: `Bearer ${patientToken}` }
    });
    expect(patientRxRes.statusCode).toBe(200);
    const patientRx = JSON.parse(patientRxRes.payload);
    expect(patientRx.clinicalNotes).toContain('Vata-Pitta imbalance diagnosed');

    // 9. Admin views analytics rollup
    const analyticsRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/analytics',
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(analyticsRes.statusCode).toBe(200);
    const analytics = JSON.parse(analyticsRes.payload);
    expect(analytics.totalConsultations).toBeGreaterThanOrEqual(1);

    // 10. Admin inspects immutable audit logs
    const auditRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs',
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(auditRes.statusCode).toBe(200);
    const auditLogs = JSON.parse(auditRes.payload);
    expect(auditLogs.length).toBeGreaterThan(0);
    expect(auditLogs.some((l: any) => l.action === 'PRESCRIPTION_ISSUED')).toBe(true);
    expect(auditLogs.some((l: any) => l.action === 'BOOKING_CONFIRMED')).toBe(true);
  });

  describe('RBAC & Security Violations Rejection', () => {
    it('should reject patient attempting to publish availability slots (403 Forbidden)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/doctors/${doctorId}/slots`,
        headers: { authorization: `Bearer ${patientToken}` },
        payload: {
          startTime: '2026-11-01T08:00:00.000Z',
          endTime: '2026-11-01T08:30:00.000Z'
        }
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.payload).error.code).toBe('FORBIDDEN');
    });

    it('should reject patient attempting to issue a prescription (403 Forbidden)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/consultations/some-id/prescription',
        headers: { authorization: `Bearer ${patientToken}` },
        payload: {
          clinicalNotes: 'Self prescribing',
          medications: [{ name: 'Meds', dosage: '1', frequency: 'daily', duration: '1d' }]
        }
      });
      expect(res.statusCode).toBe(403);
    });

    it('should reject non-admin from accessing admin analytics (403 Forbidden)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/analytics',
        headers: { authorization: `Bearer ${patientToken}` }
      });
      expect(res.statusCode).toBe(403);
    });

    it('should reject unauthenticated request with 401 Unauthorized', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/analytics'
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.payload).error.code).toBe('UNAUTHORIZED');
    });
  });
});
