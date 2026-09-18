import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { BookingService } from './booking.service';
import { TokenService } from '../auth/token.service';
import { IDatabase } from '../../infra/db/database.interface';
import { createAuthMiddleware } from '../../middleware/auth';
import { roleGuard } from '../../middleware/rbac';
import { createIdempotencyMiddleware } from '../../middleware/idempotency';
import { reserveSlotSchema, confirmBookingSchema } from './booking.schema';

export function createBookingRoutes(
  bookingService: BookingService,
  tokenService: TokenService,
  db: IDatabase
): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    const authGuard = createAuthMiddleware(tokenService);
    const idempotencyGuard = createIdempotencyMiddleware(db, true);

    fastify.post(
      '/reserve',
      { preHandler: [authGuard, roleGuard(['patient', 'admin']), idempotencyGuard] },
      async (request, reply) => {
        const userId = request.user!.userId;
        const idempotencyKey = request.headers['idempotency-key'] as string;
        const validated = reserveSlotSchema.parse(request.body);

        const result = await bookingService.reserveSlot(userId, validated, idempotencyKey);
        return reply.status(201).send({
          consultationId: result.consultation.id,
          slotId: result.consultation.slotId,
          status: result.consultation.status,
          payment: {
            id: result.payment.id,
            amountCents: result.payment.amountCents,
            currency: result.payment.currency,
            status: result.payment.status
          }
        });
      }
    );

    fastify.post(
      '/confirm',
      { preHandler: [authGuard, roleGuard(['patient', 'admin']), idempotencyGuard] },
      async (request, reply) => {
        const userId = request.user!.userId;
        const idempotencyKey = request.headers['idempotency-key'] as string;
        const validated = confirmBookingSchema.parse(request.body);

        const result = await bookingService.confirmBooking(userId, validated, idempotencyKey);
        return reply.status(200).send(result);
      }
    );
  };
}
