import {
  IDatabase,
  ConsultationEntity,
  ConsultationStatus,
  UserRole
} from '../../infra/db/database.interface';
import { AuditService } from '../audit/audit.service';
import { UpdateConsultationStatusInput } from './consultations.schema';

export class ConsultationsService {
  constructor(
    private db: IDatabase,
    private audit: AuditService
  ) {}

  async getConsultation(
    consultationId: string,
    userId: string,
    role: UserRole
  ): Promise<ConsultationEntity> {
    const consultation = await this.db.consultations.findById(consultationId);
    if (!consultation) {
      throw { statusCode: 404, code: 'CONSULTATION_NOT_FOUND', message: 'Consultation not found' };
    }

    // Role-based access restriction: only assigned patient, assigned doctor, or admin can view
    if (role === 'patient' && consultation.patientId !== userId) {
      throw { statusCode: 403, code: 'FORBIDDEN', message: 'You do not have permission to view this consultation' };
    }
    if (role === 'doctor' && consultation.doctorId !== userId) {
      throw { statusCode: 403, code: 'FORBIDDEN', message: 'You do not have permission to view this consultation' };
    }

    return consultation;
  }

  async listUserConsultations(userId: string, role: UserRole): Promise<ConsultationEntity[]> {
    if (role === 'patient') {
      return await this.db.consultations.findByPatient(userId);
    } else if (role === 'doctor') {
      return await this.db.consultations.findByDoctor(userId);
    }
    return [];
  }

  /**
   * Advances consultation lifecycle state with Optimistic Concurrency Control (version checking).
   */
  async updateStatus(
    consultationId: string,
    userId: string,
    role: UserRole,
    input: UpdateConsultationStatusInput
  ): Promise<ConsultationEntity> {
    const current = await this.db.consultations.findById(consultationId);
    if (!current) {
      throw { statusCode: 404, code: 'CONSULTATION_NOT_FOUND', message: 'Consultation not found' };
    }

    // Authorization checks
    if (role === 'patient') {
      if (current.patientId !== userId) {
        throw { statusCode: 403, code: 'FORBIDDEN', message: 'You are not the patient for this consultation' };
      }
      if (input.status !== 'cancelled') {
        throw { statusCode: 403, code: 'FORBIDDEN', message: 'Patients can only cancel consultations' };
      }
    } else if (role === 'doctor') {
      if (current.doctorId !== userId) {
        throw { statusCode: 403, code: 'FORBIDDEN', message: 'You are not the assigned doctor for this consultation' };
      }
      // Doctors can transition: scheduled -> in_progress, in_progress -> completed, scheduled -> cancelled, scheduled -> no_show
    }

    // State machine validation
    this.validateStateTransition(current.status, input.status);

    // Optimistic Concurrency Control
    const updated = await this.db.consultations.updateStatusOptimistic(
      consultationId,
      input.expectedVersion,
      input.status
    );

    if (!updated) {
      throw {
        statusCode: 409,
        code: 'CONCURRENCY_CONFLICT',
        message: `Version conflict: Consultation was modified concurrently. Expected version ${input.expectedVersion}, but current state does not match.`
      };
    }

    // If cancelled, free the availability slot
    if (input.status === 'cancelled') {
      await this.db.slots.updateStatus(current.slotId, 'open');
    }

    // Immutable audit trail recording
    await this.audit.record({
      actorId: userId,
      action: `CONSULTATION_STATUS_${input.status.toUpperCase()}`,
      entityType: 'Consultation',
      entityId: consultationId,
      before: { status: current.status, version: current.version },
      after: { status: updated.status, version: updated.version }
    });

    return updated;
  }

  private validateStateTransition(current: ConsultationStatus, target: ConsultationStatus): void {
    if (current === target) return;

    if (current === 'completed' || current === 'cancelled' || current === 'no_show') {
      throw {
        statusCode: 400,
        code: 'TERMINAL_STATE',
        message: `Cannot transition consultation from terminal state '${current}' to '${target}'`
      };
    }

    if (current === 'scheduled') {
      if (!['in_progress', 'cancelled', 'no_show'].includes(target)) {
        throw {
          statusCode: 400,
          code: 'INVALID_STATE_TRANSITION',
          message: `Cannot transition from 'scheduled' directly to '${target}'`
        };
      }
    }

    if (current === 'in_progress') {
      if (!['completed', 'cancelled'].includes(target)) {
        throw {
          statusCode: 400,
          code: 'INVALID_STATE_TRANSITION',
          message: `Cannot transition from 'in_progress' to '${target}'`
        };
      }
    }
  }
}
