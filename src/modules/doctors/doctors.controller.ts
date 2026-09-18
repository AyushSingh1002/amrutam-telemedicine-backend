import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { DoctorsService } from './doctors.service';
import { TokenService } from '../auth/token.service';
import { createAuthMiddleware } from '../../middleware/auth';
import { roleGuard } from '../../middleware/rbac';
import { createSlotSchema } from './doctors.schema';

export function createDoctorRoutes(doctorsService: DoctorsService, tokenService: TokenService): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    const authGuard = createAuthMiddleware(tokenService);

    fastify.get('/:doctorId', async (request, reply) => {
      const { doctorId } = request.params as { doctorId: string };
      const doctor = await doctorsService.getDoctor(doctorId);
      return reply.send(doctor);
    });

    fastify.get('/:doctorId/slots', async (request, reply) => {
      const { doctorId } = request.params as { doctorId: string };
      const slots = await doctorsService.getOpenSlots(doctorId);
      return reply.send(slots);
    });

    fastify.post(
      '/:doctorId/slots',
      { preHandler: [authGuard, roleGuard(['doctor', 'admin'])] },
      async (request, reply) => {
        const { doctorId } = request.params as { doctorId: string };
        const authenticatedUser = request.user!;

        // Ensure doctor only creates slots for themselves (unless admin)
        if (authenticatedUser.role === 'doctor' && authenticatedUser.userId !== doctorId) {
          return reply.status(403).send({
            error: {
              code: 'FORBIDDEN',
              message: 'Doctors can only publish availability slots for their own account'
            }
          });
        }

        const validated = createSlotSchema.parse(request.body);
        const slot = await doctorsService.publishSlot(doctorId, validated);
        return reply.status(201).send(slot);
      }
    );
  };
}
