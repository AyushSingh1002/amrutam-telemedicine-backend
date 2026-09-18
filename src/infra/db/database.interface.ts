export type UserRole = 'patient' | 'doctor' | 'admin';
export type SlotStatus = 'open' | 'held' | 'booked' | 'cancelled';
export type ConsultationStatus = 'scheduled' | 'in_progress' | 'completed' | 'cancelled' | 'no_show';
export type PaymentStatus = 'pending' | 'captured' | 'failed' | 'refunded';

export interface UserEntity {
  id: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  mfaSecret?: string | null;
  mfaEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  profile?: ProfileEntity;
  doctor?: DoctorEntity;
}

export interface ProfileEntity {
  userId: string;
  fullName: string;
  phone?: string | null;
  dateOfBirth?: string | null;
  metadata?: Record<string, any>;
}

export interface DoctorEntity {
  userId: string;
  specialty: string;
  licenseNumber: string;
  languages: string[];
  rating: number;
  user?: UserEntity;
  profile?: ProfileEntity;
}

export interface AvailabilitySlotEntity {
  id: string;
  doctorId: string;
  startTime: Date;
  endTime: Date;
  status: SlotStatus;
}

export interface ConsultationEntity {
  id: string;
  patientId: string;
  doctorId: string;
  slotId: string;
  status: ConsultationStatus;
  idempotencyKey: string;
  version: number;
  createdAt: Date;
  meetingLink?: string;
  slot?: AvailabilitySlotEntity;
  doctor?: DoctorEntity;
  patient?: UserEntity;
  payment?: PaymentEntity;
  prescription?: PrescriptionEntity;
}

export interface PrescriptionEntity {
  id: string;
  consultationId: string;
  doctorId: string;
  notesEncrypted: Buffer;
  medications: Array<{
    name: string;
    dosage: string;
    frequency: string;
    duration: string;
  }>;
  issuedAt: Date;
}

export interface PaymentEntity {
  id: string;
  consultationId: string;
  amountCents: number;
  currency: string;
  status: PaymentStatus;
  idempotencyKey: string;
  providerRef?: string | null;
  createdAt: Date;
}

export interface AuditLogEntity {
  id: number;
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before?: Record<string, any> | null;
  after?: Record<string, any> | null;
  createdAt: Date;
}

export interface IdempotencyRecordEntity {
  key: string;
  requestHash: string;
  responseCode: number;
  responseBody: any;
  createdAt: Date;
  expiresAt: Date;
}

export interface IDatabase {
  users: {
    findById(id: string): Promise<UserEntity | null>;
    findByEmail(email: string): Promise<UserEntity | null>;
    create(data: {
      email: string;
      passwordHash: string;
      role: UserRole;
      profile: {
        fullName: string;
        phone?: string;
        dateOfBirth?: string;
      };
      doctor?: {
        specialty: string;
        licenseNumber: string;
        languages: string[];
      };
    }): Promise<UserEntity>;
    updateMfa(id: string, mfaSecret: string | null, mfaEnabled: boolean): Promise<void>;
  };

  doctors: {
    findById(userId: string): Promise<DoctorEntity | null>;
    search(filters: {
      specialty?: string;
      language?: string;
      minRating?: number;
      availableFrom?: Date;
      availableTo?: Date;
      page: number;
      limit: number;
    }): Promise<{ doctors: DoctorEntity[]; total: number }>;
  };

  slots: {
    createSlot(data: {
      doctorId: string;
      startTime: Date;
      endTime: Date;
    }): Promise<AvailabilitySlotEntity>;
    findById(id: string): Promise<AvailabilitySlotEntity | null>;
    findOpenByDoctor(doctorId: string): Promise<AvailabilitySlotEntity[]>;
    // Concurrency control: Atomic select FOR UPDATE and transition 'open' -> 'held'
    acquireSlotLockAndHold(slotId: string): Promise<AvailabilitySlotEntity | null>;
    updateStatus(slotId: string, status: SlotStatus): Promise<AvailabilitySlotEntity | null>;
  };

  consultations: {
    create(data: {
      patientId: string;
      doctorId: string;
      slotId: string;
      idempotencyKey: string;
      status?: ConsultationStatus;
      meetingLink?: string;
    }): Promise<ConsultationEntity>;
    findById(id: string): Promise<ConsultationEntity | null>;
    findByPatient(patientId: string): Promise<ConsultationEntity[]>;
    findByDoctor(doctorId: string): Promise<ConsultationEntity[]>;
    // Optimistic locking update
    updateStatusOptimistic(
      id: string,
      expectedVersion: number,
      newStatus: ConsultationStatus
    ): Promise<ConsultationEntity | null>;
  };

  prescriptions: {
    create(data: {
      consultationId: string;
      doctorId: string;
      notesEncrypted: Buffer;
      medications: any[];
    }): Promise<PrescriptionEntity>;
    findByConsultation(consultationId: string): Promise<PrescriptionEntity | null>;
  };

  payments: {
    create(data: {
      consultationId: string;
      amountCents: number;
      currency: string;
      status: PaymentStatus;
      idempotencyKey: string;
      providerRef?: string;
    }): Promise<PaymentEntity>;
    findByConsultation(consultationId: string): Promise<PaymentEntity | null>;
    updateStatus(
      id: string,
      status: PaymentStatus,
      providerRef?: string
    ): Promise<PaymentEntity | null>;
  };

  auditLogs: {
    append(data: {
      actorId?: string | null;
      action: string;
      entityType: string;
      entityId: string;
      before?: any;
      after?: any;
    }): Promise<AuditLogEntity>;
    query(filters: {
      entityType?: string;
      entityId?: string;
      actorId?: string;
      limit?: number;
    }): Promise<AuditLogEntity[]>;
  };

  idempotency: {
    get(key: string): Promise<IdempotencyRecordEntity | null>;
    save(record: IdempotencyRecordEntity): Promise<void>;
  };

  admin: {
    getAnalytics(): Promise<{
      consultationsPerDay: number;
      noShowRatePercentage: number;
      averageTimeToBookHours: number;
      doctorUtilizationPercentage: number;
      totalConsultations: number;
      totalDoctors: number;
      totalPatients: number;
    }>;
  };

  ping(): Promise<boolean>;
}
