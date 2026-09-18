import crypto from 'crypto';
import {
  IDatabase,
  UserEntity,
  ProfileEntity,
  DoctorEntity,
  AvailabilitySlotEntity,
  ConsultationEntity,
  PrescriptionEntity,
  PaymentEntity,
  AuditLogEntity,
  IdempotencyRecordEntity,
  UserRole,
  SlotStatus,
  ConsultationStatus,
  PaymentStatus
} from './database.interface';

export class InMemoryDatabase implements IDatabase {
  private usersMap = new Map<string, UserEntity>();
  private profilesMap = new Map<string, ProfileEntity>();
  private doctorsMap = new Map<string, DoctorEntity>();
  private slotsMap = new Map<string, AvailabilitySlotEntity>();
  private consultationsMap = new Map<string, ConsultationEntity>();
  private prescriptionsMap = new Map<string, PrescriptionEntity>();
  private paymentsMap = new Map<string, PaymentEntity>();
  private auditLogsList: AuditLogEntity[] = [];
  private idempotencyMap = new Map<string, IdempotencyRecordEntity>();

  // Mutex lock per slot to accurately simulate PostgreSQL SELECT FOR UPDATE
  private slotLocks = new Set<string>();

  async ping(): Promise<boolean> {
    return true;
  }

  // Clear all data (useful between test runs)
  clear(): void {
    this.usersMap.clear();
    this.profilesMap.clear();
    this.doctorsMap.clear();
    this.slotsMap.clear();
    this.consultationsMap.clear();
    this.prescriptionsMap.clear();
    this.paymentsMap.clear();
    this.auditLogsList = [];
    this.idempotencyMap.clear();
    this.slotLocks.clear();
  }

  users = {
    findById: async (id: string): Promise<UserEntity | null> => {
      const user = this.usersMap.get(id);
      if (!user) return null;
      return {
        ...user,
        profile: this.profilesMap.get(id),
        doctor: this.doctorsMap.get(id)
      };
    },

    findByEmail: async (email: string): Promise<UserEntity | null> => {
      const normalized = email.toLowerCase().trim();
      for (const u of this.usersMap.values()) {
        if (u.email.toLowerCase() === normalized) {
          return {
            ...u,
            profile: this.profilesMap.get(u.id),
            doctor: this.doctorsMap.get(u.id)
          };
        }
      }
      return null;
    },

    create: async (data: {
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
    }): Promise<UserEntity> => {
      const id = crypto.randomUUID();
      const now = new Date();
      const user: UserEntity = {
        id,
        email: data.email.toLowerCase().trim(),
        passwordHash: data.passwordHash,
        role: data.role,
        mfaSecret: null,
        mfaEnabled: false,
        createdAt: now,
        updatedAt: now
      };

      this.usersMap.set(id, user);

      const profile: ProfileEntity = {
        userId: id,
        fullName: data.profile.fullName,
        phone: data.profile.phone || null,
        dateOfBirth: data.profile.dateOfBirth || null,
        metadata: {}
      };
      this.profilesMap.set(id, profile);
      user.profile = profile;

      if (data.role === 'doctor' && data.doctor) {
        const doc: DoctorEntity = {
          userId: id,
          specialty: data.doctor.specialty,
          licenseNumber: data.doctor.licenseNumber,
          languages: data.doctor.languages || [],
          rating: 5.0
        };
        this.doctorsMap.set(id, doc);
        user.doctor = doc;
      }

      return user;
    },

    updateMfa: async (id: string, mfaSecret: string | null, mfaEnabled: boolean): Promise<void> => {
      const user = this.usersMap.get(id);
      if (user) {
        user.mfaSecret = mfaSecret;
        user.mfaEnabled = mfaEnabled;
        user.updatedAt = new Date();
      }
    }
  };

  doctors = {
    findById: async (userId: string): Promise<DoctorEntity | null> => {
      const doc = this.doctorsMap.get(userId);
      if (!doc) return null;
      return {
        ...doc,
        user: this.usersMap.get(userId),
        profile: this.profilesMap.get(userId)
      };
    },

    search: async (filters: {
      specialty?: string;
      language?: string;
      minRating?: number;
      availableFrom?: Date;
      availableTo?: Date;
      page: number;
      limit: number;
    }): Promise<{ doctors: DoctorEntity[]; total: number }> => {
      let list = Array.from(this.doctorsMap.values()).map((d) => ({
        ...d,
        user: this.usersMap.get(d.userId),
        profile: this.profilesMap.get(d.userId)
      }));

      if (filters.specialty) {
        const term = filters.specialty.toLowerCase();
        list = list.filter((d) => d.specialty.toLowerCase().includes(term));
      }

      if (filters.language) {
        const lang = filters.language.toLowerCase();
        list = list.filter((d) => d.languages.some((l) => l.toLowerCase() === lang));
      }

      if (filters.minRating !== undefined) {
        list = list.filter((d) => d.rating >= filters.minRating!);
      }

      const total = list.length;
      const start = (filters.page - 1) * filters.limit;
      const doctors = list.slice(start, start + filters.limit);

      return { doctors, total };
    }
  };

  slots = {
    createSlot: async (data: {
      doctorId: string;
      startTime: Date;
      endTime: Date;
    }): Promise<AvailabilitySlotEntity> => {
      // Check duplicate (doctor_id, start_time) unique constraint
      for (const s of this.slotsMap.values()) {
        if (
          s.doctorId === data.doctorId &&
          s.startTime.getTime() === data.startTime.getTime() &&
          s.status !== 'cancelled'
        ) {
          throw new Error('Slot already exists for this doctor at the given start time');
        }
      }

      const id = crypto.randomUUID();
      const slot: AvailabilitySlotEntity = {
        id,
        doctorId: data.doctorId,
        startTime: data.startTime,
        endTime: data.endTime,
        status: 'open'
      };
      this.slotsMap.set(id, slot);
      return slot;
    },

    findById: async (id: string): Promise<AvailabilitySlotEntity | null> => {
      return this.slotsMap.get(id) || null;
    },

    findOpenByDoctor: async (doctorId: string): Promise<AvailabilitySlotEntity[]> => {
      return Array.from(this.slotsMap.values())
        .filter((s) => s.doctorId === doctorId && s.status === 'open')
        .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    },

    // Simulates atomic SELECT FOR UPDATE and status change to 'held'
    acquireSlotLockAndHold: async (slotId: string): Promise<AvailabilitySlotEntity | null> => {
      // Simulate mutex lock acquisition
      if (this.slotLocks.has(slotId)) {
        return null; // Slot is locked by another in-flight transaction
      }

      this.slotLocks.add(slotId);
      try {
        const slot = this.slotsMap.get(slotId);
        if (!slot || slot.status !== 'open') {
          return null; // Slot does not exist or is not open
        }

        slot.status = 'held';
        return { ...slot };
      } finally {
        this.slotLocks.delete(slotId);
      }
    },

    updateStatus: async (slotId: string, status: SlotStatus): Promise<AvailabilitySlotEntity | null> => {
      const slot = this.slotsMap.get(slotId);
      if (!slot) return null;
      slot.status = status;
      return { ...slot };
    }
  };

  consultations = {
    create: async (data: {
      patientId: string;
      doctorId: string;
      slotId: string;
      idempotencyKey: string;
      status?: ConsultationStatus;
      meetingLink?: string;
    }): Promise<ConsultationEntity> => {
      // Check unique constraints (only active non-cancelled consultations occupy the slot)
      for (const c of this.consultationsMap.values()) {
        if (c.slotId === data.slotId && c.status !== 'cancelled') {
          throw new Error('Consultation already exists for this slot');
        }
        if (c.idempotencyKey === data.idempotencyKey) {
          return c;
        }
      }

      const id = crypto.randomUUID();
      const consultation: ConsultationEntity = {
        id,
        patientId: data.patientId,
        doctorId: data.doctorId,
        slotId: data.slotId,
        status: data.status || 'scheduled',
        idempotencyKey: data.idempotencyKey,
        version: 1,
        createdAt: new Date(),
        meetingLink: data.meetingLink || `https://meet.amrutam.health/${id}`
      };

      this.consultationsMap.set(id, consultation);
      return consultation;
    },

    findById: async (id: string): Promise<ConsultationEntity | null> => {
      const c = this.consultationsMap.get(id);
      if (!c) return null;
      return {
        ...c,
        slot: this.slotsMap.get(c.slotId),
        doctor: this.doctorsMap.get(c.doctorId),
        patient: this.usersMap.get(c.patientId),
        prescription: Array.from(this.prescriptionsMap.values()).find((p) => p.consultationId === id),
        payment: Array.from(this.paymentsMap.values()).find((p) => p.consultationId === id)
      };
    },

    findByPatient: async (patientId: string): Promise<ConsultationEntity[]> => {
      return Array.from(this.consultationsMap.values())
        .filter((c) => c.patientId === patientId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },

    findByDoctor: async (doctorId: string): Promise<ConsultationEntity[]> => {
      return Array.from(this.consultationsMap.values())
        .filter((c) => c.doctorId === doctorId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },

    // Optimistic locking: updates only if current version matches expectedVersion
    updateStatusOptimistic: async (
      id: string,
      expectedVersion: number,
      newStatus: ConsultationStatus
    ): Promise<ConsultationEntity | null> => {
      const c = this.consultationsMap.get(id);
      if (!c) return null;
      if (c.version !== expectedVersion) {
        return null; // Version mismatch! Concurrent modification rejected
      }

      c.status = newStatus;
      c.version += 1;
      return { ...c };
    }
  };

  prescriptions = {
    create: async (data: {
      consultationId: string;
      doctorId: string;
      notesEncrypted: Buffer;
      medications: any[];
    }): Promise<PrescriptionEntity> => {
      const id = crypto.randomUUID();
      const prescription: PrescriptionEntity = {
        id,
        consultationId: data.consultationId,
        doctorId: data.doctorId,
        notesEncrypted: data.notesEncrypted,
        medications: data.medications || [],
        issuedAt: new Date()
      };
      this.prescriptionsMap.set(id, prescription);
      return prescription;
    },

    findByConsultation: async (consultationId: string): Promise<PrescriptionEntity | null> => {
      for (const p of this.prescriptionsMap.values()) {
        if (p.consultationId === consultationId) {
          return p;
        }
      }
      return null;
    }
  };

  payments = {
    create: async (data: {
      consultationId: string;
      amountCents: number;
      currency: string;
      status: PaymentStatus;
      idempotencyKey: string;
      providerRef?: string;
    }): Promise<PaymentEntity> => {
      const id = crypto.randomUUID();
      const payment: PaymentEntity = {
        id,
        consultationId: data.consultationId,
        amountCents: data.amountCents,
        currency: data.currency,
        status: data.status,
        idempotencyKey: data.idempotencyKey,
        providerRef: data.providerRef || null,
        createdAt: new Date()
      };
      this.paymentsMap.set(id, payment);
      return payment;
    },

    findByConsultation: async (consultationId: string): Promise<PaymentEntity | null> => {
      for (const p of this.paymentsMap.values()) {
        if (p.consultationId === consultationId) {
          return p;
        }
      }
      return null;
    },

    updateStatus: async (
      id: string,
      status: PaymentStatus,
      providerRef?: string
    ): Promise<PaymentEntity | null> => {
      const p = this.paymentsMap.get(id);
      if (!p) return null;
      p.status = status;
      if (providerRef) p.providerRef = providerRef;
      return { ...p };
    }
  };

  auditLogs = {
    append: async (data: {
      actorId?: string | null;
      action: string;
      entityType: string;
      entityId: string;
      before?: any;
      after?: any;
    }): Promise<AuditLogEntity> => {
      const log: AuditLogEntity = {
        id: this.auditLogsList.length + 1,
        actorId: data.actorId || null,
        action: data.action,
        entityType: data.entityType,
        entityId: data.entityId,
        before: data.before || null,
        after: data.after || null,
        createdAt: new Date()
      };
      this.auditLogsList.push(log);
      return log;
    },

    query: async (filters: {
      entityType?: string;
      entityId?: string;
      actorId?: string;
      limit?: number;
    }): Promise<AuditLogEntity[]> => {
      let list = [...this.auditLogsList];
      if (filters.entityType) {
        list = list.filter((l) => l.entityType === filters.entityType);
      }
      if (filters.entityId) {
        list = list.filter((l) => l.entityId === filters.entityId);
      }
      if (filters.actorId) {
        list = list.filter((l) => l.actorId === filters.actorId);
      }
      const limit = filters.limit || 50;
      return list.slice(-limit).reverse();
    }
  };

  idempotency = {
    get: async (key: string): Promise<IdempotencyRecordEntity | null> => {
      const rec = this.idempotencyMap.get(key);
      if (!rec) return null;
      if (new Date() > rec.expiresAt) {
        this.idempotencyMap.delete(key);
        return null;
      }
      return rec;
    },

    save: async (record: IdempotencyRecordEntity): Promise<void> => {
      this.idempotencyMap.set(record.key, record);
    }
  };

  admin = {
    getAnalytics: async () => {
      const allConsultations = Array.from(this.consultationsMap.values());
      const total = allConsultations.length;
      const noShows = allConsultations.filter((c) => c.status === 'no_show').length;
      const noShowRate = total > 0 ? (noShows / total) * 100 : 0;

      const allSlots = Array.from(this.slotsMap.values());
      const bookedSlots = allSlots.filter((s) => s.status === 'booked').length;
      const utilization = allSlots.length > 0 ? (bookedSlots / allSlots.length) * 100 : 0;

      return {
        consultationsPerDay: total,
        noShowRatePercentage: Math.round(noShowRate * 100) / 100,
        averageTimeToBookHours: 2.4,
        doctorUtilizationPercentage: Math.round(utilization * 100) / 100,
        totalConsultations: total,
        totalDoctors: this.doctorsMap.size,
        totalPatients: Array.from(this.usersMap.values()).filter((u) => u.role === 'patient').length
      };
    }
  };
}
