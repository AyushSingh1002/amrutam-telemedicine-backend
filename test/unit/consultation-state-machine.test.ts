import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryDatabase } from '../../src/infra/db/in-memory-db';
import { ConsultationsService } from '../../src/modules/consultations/consultations.service';
import { AuditService } from '../../src/modules/audit/audit.service';

describe('Consultation Lifecycle & Optimistic Locking', () => {
  let db: InMemoryDatabase;
  let auditService: AuditService;
  let consultationsService: ConsultationsService;

  const doctorId = 'd-100';
  const patientId = 'p-200';
  let consultationId: string;

  beforeEach(async () => {
    db = new InMemoryDatabase();
    auditService = new AuditService(db);
    consultationsService = new ConsultationsService(db, auditService);

    // Setup doctor and patient
    await db.users.create({
      email: 'doctor@amrutam.health',
      passwordHash: 'hash',
      role: 'doctor',
      profile: { fullName: 'Dr. Sharma' },
      doctor: { specialty: 'Ayurveda', licenseNumber: 'AYU-12345', languages: ['English', 'Hindi'] }
    });

    const slot = await db.slots.createSlot({
      doctorId,
      startTime: new Date('2026-10-01T10:00:00Z'),
      endTime: new Date('2026-10-01T10:30:00Z')
    });

    const consultation = await db.consultations.create({
      patientId,
      doctorId,
      slotId: slot.id,
      idempotencyKey: 'test-idem-key-1'
    });
    consultationId = consultation.id;
  });

  it('should advance scheduled -> in_progress -> completed by assigned doctor', async () => {
    // 1. Doctor starts consultation
    const started = await consultationsService.updateStatus(
      consultationId,
      doctorId,
      'doctor',
      { status: 'in_progress', expectedVersion: 1 }
    );
    expect(started.status).toBe('in_progress');
    expect(started.version).toBe(2);

    // 2. Doctor completes consultation
    const completed = await consultationsService.updateStatus(
      consultationId,
      doctorId,
      'doctor',
      { status: 'completed', expectedVersion: 2 }
    );
    expect(completed.status).toBe('completed');
    expect(completed.version).toBe(3);
  });

  it('should reject invalid state transition (scheduled -> completed directly)', async () => {
    await expect(
      consultationsService.updateStatus(
        consultationId,
        doctorId,
        'doctor',
        { status: 'completed', expectedVersion: 1 }
      )
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_STATE_TRANSITION'
    });
  });

  it('should reject state change if expectedVersion does not match (optimistic lock conflict)', async () => {
    // Stale update: someone else already updated from version 1 to 2
    await consultationsService.updateStatus(
      consultationId,
      doctorId,
      'doctor',
      { status: 'in_progress', expectedVersion: 1 }
    );

    // Client passes stale expectedVersion 1
    await expect(
      consultationsService.updateStatus(
        consultationId,
        doctorId,
        'doctor',
        { status: 'completed', expectedVersion: 1 }
      )
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONCURRENCY_CONFLICT'
    });
  });

  it('should forbid unassigned doctor from modifying consultation', async () => {
    const unassignedDoctorId = 'd-999';
    await expect(
      consultationsService.updateStatus(
        consultationId,
        unassignedDoctorId,
        'doctor',
        { status: 'in_progress', expectedVersion: 1 }
      )
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN'
    });
  });
});
