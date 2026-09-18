import { IDatabase, UserRole } from '../../infra/db/database.interface';
import { CryptoService } from './crypto.service';
import { AuditService } from '../audit/audit.service';
import { IssuePrescriptionInput } from './prescriptions.schema';

export interface DecryptedPrescription {
  id: string;
  consultationId: string;
  doctorId: string;
  clinicalNotes: string;
  medications: any[];
  issuedAt: Date;
}

export class PrescriptionsService {
  constructor(
    private db: IDatabase,
    private cryptoService: CryptoService,
    private audit: AuditService
  ) {}

  async issuePrescription(
    consultationId: string,
    doctorId: string,
    input: IssuePrescriptionInput
  ): Promise<DecryptedPrescription> {
    const consultation = await this.db.consultations.findById(consultationId);
    if (!consultation) {
      throw { statusCode: 404, code: 'CONSULTATION_NOT_FOUND', message: 'Consultation not found' };
    }

    if (consultation.doctorId !== doctorId) {
      throw {
        statusCode: 403,
        code: 'FORBIDDEN',
        message: 'Only the assigned doctor can issue a prescription for this consultation'
      };
    }

    if (consultation.status !== 'in_progress' && consultation.status !== 'completed') {
      throw {
        statusCode: 400,
        code: 'INVALID_CONSULTATION_STATE',
        message: `Prescriptions can only be issued during or after consultation (current status: ${consultation.status})`
      };
    }

    const existing = await this.db.prescriptions.findByConsultation(consultationId);
    if (existing) {
      throw {
        statusCode: 409,
        code: 'PRESCRIPTION_ALREADY_EXISTS',
        message: 'A prescription has already been issued for this consultation'
      };
    }

    // Encrypt sensitive clinical notes using AES-256-GCM
    const notesEncrypted = this.cryptoService.encrypt(input.clinicalNotes);

    const prescription = await this.db.prescriptions.create({
      consultationId,
      doctorId,
      notesEncrypted,
      medications: input.medications
    });

    await this.audit.record({
      actorId: doctorId,
      action: 'PRESCRIPTION_ISSUED',
      entityType: 'Prescription',
      entityId: prescription.id,
      after: { consultationId, doctorId, medicationCount: input.medications.length }
    });

    return {
      id: prescription.id,
      consultationId: prescription.consultationId,
      doctorId: prescription.doctorId,
      clinicalNotes: input.clinicalNotes,
      medications: prescription.medications,
      issuedAt: prescription.issuedAt
    };
  }

  async getPrescription(
    consultationId: string,
    userId: string,
    role: UserRole
  ): Promise<DecryptedPrescription> {
    const consultation = await this.db.consultations.findById(consultationId);
    if (!consultation) {
      throw { statusCode: 404, code: 'CONSULTATION_NOT_FOUND', message: 'Consultation not found' };
    }

    // Authorization: only assigned patient, assigned doctor, or admin
    if (role === 'patient' && consultation.patientId !== userId) {
      throw { statusCode: 403, code: 'FORBIDDEN', message: 'You cannot view prescriptions for another patient' };
    }
    if (role === 'doctor' && consultation.doctorId !== userId) {
      throw { statusCode: 403, code: 'FORBIDDEN', message: 'You cannot view prescriptions for another doctor' };
    }

    const prescription = await this.db.prescriptions.findByConsultation(consultationId);
    if (!prescription) {
      throw { statusCode: 404, code: 'PRESCRIPTION_NOT_FOUND', message: 'No prescription found for this consultation' };
    }

    // Decrypt on-the-fly
    const clinicalNotes = this.cryptoService.decrypt(prescription.notesEncrypted);

    return {
      id: prescription.id,
      consultationId: prescription.consultationId,
      doctorId: prescription.doctorId,
      clinicalNotes,
      medications: prescription.medications,
      issuedAt: prescription.issuedAt
    };
  }
}
