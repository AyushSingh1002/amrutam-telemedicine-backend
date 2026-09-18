import crypto from 'crypto';
import { IDatabase, ConsultationEntity, PaymentEntity } from '../../infra/db/database.interface';
import { IPaymentProvider } from '../../infra/providers/payment.interface';
import { IQueueService } from '../../infra/queue/queue.interface';
import { ICacheService } from '../../infra/cache/cache.interface';
import { AuditService } from '../audit/audit.service';
import { NOTIFICATION_QUEUE_NAME } from '../../jobs/notification.job';
import { REMINDER_QUEUE_NAME } from '../../jobs/reminder.job';
import { ReserveSlotInput, ConfirmBookingInput } from './booking.schema';
import { logger } from '../../infra/observability/logger';

export interface ReservationResult {
  consultation: ConsultationEntity;
  payment: PaymentEntity;
}

export interface BookingConfirmationResult {
  consultationId: string;
  status: string;
  paymentStatus: string;
  providerRef?: string | null;
  slotReleased?: boolean;
}

export class BookingService {
  constructor(
    private db: IDatabase,
    private paymentProvider: IPaymentProvider,
    private queue: IQueueService,
    private cache: ICacheService,
    private audit: AuditService
  ) {}

  /**
   * SAGA STEP 1: Reserve Slot & Initialize Pending Consultation
   * Uses row-level lock (SELECT FOR UPDATE simulation) to acquire and hold the slot.
   */
  async reserveSlot(
    patientId: string,
    input: ReserveSlotInput,
    idempotencyKey: string
  ): Promise<ReservationResult> {
    // 1. Concurrency control: acquire row-level lock and transition slot from 'open' -> 'held'
    const heldSlot = await this.db.slots.acquireSlotLockAndHold(input.slotId);
    if (!heldSlot) {
      throw {
        statusCode: 409,
        code: 'SLOT_UNAVAILABLE',
        message: 'This slot is already booked, held by another patient, or not open'
      };
    }

    try {
      // 2. Create consultation in 'scheduled' state
      const consultation = await this.db.consultations.create({
        patientId,
        doctorId: heldSlot.doctorId,
        slotId: heldSlot.id,
        idempotencyKey,
        status: 'scheduled'
      });

      // 3. Create payment record in 'pending' state
      const paymentIdempotencyKey = `pay_${idempotencyKey}`;
      const payment = await this.db.payments.create({
        consultationId: consultation.id,
        amountCents: input.amountCents,
        currency: 'INR',
        status: 'pending',
        idempotencyKey: paymentIdempotencyKey
      });

      // 4. Audit trail
      await this.audit.record({
        actorId: patientId,
        action: 'SLOT_RESERVED',
        entityType: 'Consultation',
        entityId: consultation.id,
        after: { slotId: heldSlot.id, amountCents: input.amountCents, status: 'scheduled' }
      });

      // 5. Invalidate doctor availability cache
      await this.cache.delByPattern(`doctor:slots:${heldSlot.doctorId}:*`);
      await this.cache.delByPattern('doctor:search:*');

      return { consultation, payment };
    } catch (err) {
      // Compensating action on creation failure: release held slot
      await this.db.slots.updateStatus(input.slotId, 'open');
      throw err;
    }
  }

  /**
   * SAGA STEP 2: Charge Payment & Confirm Consultation OR Compensate & Release
   */
  async confirmBooking(
    userId: string,
    input: ConfirmBookingInput,
    idempotencyKey: string
  ): Promise<BookingConfirmationResult> {
    const consultation = await this.db.consultations.findById(input.consultationId);
    if (!consultation) {
      throw { statusCode: 404, code: 'CONSULTATION_NOT_FOUND', message: 'Consultation not found' };
    }

    const payment = await this.db.payments.findByConsultation(consultation.id);
    if (!payment) {
      throw { statusCode: 404, code: 'PAYMENT_RECORD_NOT_FOUND', message: 'Payment record not found' };
    }

    // If already captured, return idempotent success
    if (payment.status === 'captured') {
      return {
        consultationId: consultation.id,
        status: consultation.status,
        paymentStatus: payment.status,
        providerRef: payment.providerRef
      };
    }

    // 1. Charge payment via payment gateway
    const chargeResult = await this.paymentProvider.charge({
      consultationId: consultation.id,
      amountCents: payment.amountCents,
      currency: payment.currency,
      idempotencyKey,
      forceFail: input.forceFail || !input.paymentSuccess
    });

    if (!chargeResult.success) {
      // ========================================================================
      // COMPENSATING TRANSACTION: Payment failed -> Release slot & cancel booking
      // ========================================================================
      logger.warn({ consultationId: consultation.id }, 'Payment charge failed. Executing compensating rollback.');

      await this.db.payments.updateStatus(payment.id, 'failed', chargeResult.providerRef);
      await this.db.slots.updateStatus(consultation.slotId, 'open');
      await this.db.consultations.updateStatusOptimistic(consultation.id, consultation.version, 'cancelled');

      await this.audit.record({
        actorId: userId,
        action: 'BOOKING_PAYMENT_FAILED_SLOT_RELEASED',
        entityType: 'Consultation',
        entityId: consultation.id,
        after: { paymentStatus: 'failed', slotStatus: 'open', consultationStatus: 'cancelled' }
      });

      // Evict cache so slot immediately shows as open again
      await this.cache.delByPattern(`doctor:slots:${consultation.doctorId}:*`);
      await this.cache.delByPattern('doctor:search:*');

      throw {
        statusCode: 402,
        code: 'PAYMENT_FAILED',
        message: chargeResult.errorMessage || 'Payment transaction failed. The held slot has been released.'
      };
    }

    // ==========================================================================
    // FORWARD TRANSACTION: Payment succeeded -> Book slot & enqueue notifications
    // ==========================================================================
    await this.db.payments.updateStatus(payment.id, 'captured', chargeResult.providerRef);
    await this.db.slots.updateStatus(consultation.slotId, 'booked');

    await this.audit.record({
      actorId: userId,
      action: 'BOOKING_CONFIRMED',
      entityType: 'Consultation',
      entityId: consultation.id,
      after: { paymentStatus: 'captured', slotStatus: 'booked', consultationStatus: 'scheduled' }
    });

    // Enqueue async confirmation notification (BullMQ)
    const patientUser = await this.db.users.findById(consultation.patientId);
    const doctorEntity = await this.db.doctors.findById(consultation.doctorId);

    await this.queue.addJob(
      NOTIFICATION_QUEUE_NAME,
      'send-confirmation-email',
      {
        consultationId: consultation.id,
        patientEmail: patientUser?.email || 'patient@example.com',
        patientName: patientUser?.profile?.fullName || 'Patient',
        doctorName: doctorEntity?.profile?.fullName || 'Doctor',
        startTime: consultation.slot?.startTime || new Date(),
        meetingLink: consultation.meetingLink || `https://meet.amrutam.health/${consultation.id}`
      }
    );

    // Enqueue reminder job
    await this.queue.addJob(
      REMINDER_QUEUE_NAME,
      'send-15m-reminder',
      {
        consultationId: consultation.id,
        recipientEmail: patientUser?.email || 'patient@example.com',
        minutesBefore: 15
      },
      { delay: 5000 } // scheduled
    );

    // Invalidate Redis cache
    await this.cache.delByPattern(`doctor:slots:${consultation.doctorId}:*`);
    await this.cache.delByPattern('doctor:search:*');

    return {
      consultationId: consultation.id,
      status: 'scheduled',
      paymentStatus: 'captured',
      providerRef: chargeResult.providerRef
    };
  }
}
