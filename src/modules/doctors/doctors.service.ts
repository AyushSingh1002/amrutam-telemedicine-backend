import { IDatabase, AvailabilitySlotEntity, DoctorEntity } from '../../infra/db/database.interface';
import { ICacheService } from '../../infra/cache/cache.interface';
import { AuditService } from '../audit/audit.service';
import { CreateSlotInput } from './doctors.schema';

export class DoctorsService {
  constructor(
    private db: IDatabase,
    private cache: ICacheService,
    private audit: AuditService
  ) {}

  async getDoctor(doctorId: string): Promise<DoctorEntity> {
    const doc = await this.db.doctors.findById(doctorId);
    if (!doc) {
      throw { statusCode: 404, code: 'DOCTOR_NOT_FOUND', message: 'Doctor profile not found' };
    }
    return doc;
  }

  async publishSlot(doctorId: string, input: CreateSlotInput): Promise<AvailabilitySlotEntity> {
    const doc = await this.db.doctors.findById(doctorId);
    if (!doc) {
      throw { statusCode: 404, code: 'DOCTOR_NOT_FOUND', message: 'Doctor profile not found' };
    }

    try {
      const slot = await this.db.slots.createSlot({
        doctorId,
        startTime: new Date(input.startTime),
        endTime: new Date(input.endTime)
      });

      // Invalidate cache on availability change
      await this.cache.delByPattern(`doctor:slots:${doctorId}:*`);
      await this.cache.delByPattern('doctor:search:*');

      await this.audit.record({
        actorId: doctorId,
        action: 'AVAILABILITY_SLOT_PUBLISHED',
        entityType: 'AvailabilitySlot',
        entityId: slot.id,
        after: { doctorId, startTime: slot.startTime, endTime: slot.endTime }
      });

      return slot;
    } catch (err) {
      if ((err as Error).message.includes('already exists')) {
        throw { statusCode: 409, code: 'SLOT_CONFLICT', message: (err as Error).message };
      }
      throw err;
    }
  }

  async getOpenSlots(doctorId: string): Promise<AvailabilitySlotEntity[]> {
    const cacheKey = `doctor:slots:${doctorId}:open`;
    const cached = await this.cache.get<AvailabilitySlotEntity[]>(cacheKey);
    if (cached) return cached;

    const slots = await this.db.slots.findOpenByDoctor(doctorId);
    await this.cache.set(cacheKey, slots, 30); // 30s cache
    return slots;
  }
}
