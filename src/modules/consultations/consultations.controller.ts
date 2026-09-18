import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { ConsultationsService } from './consultations.service';
import { TokenService } from '../auth/token.service';
import { createAuthMiddleware } from '../../middleware/auth';
import { updateConsultationStatusSchema } from './consultations.schema';

export function createConsultationRoutes(
  consultationsService: ConsultationsService,
  tokenService: TokenService
): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    const authGuard = createAuthMiddleware(tokenService);

    fastify.get('/', { preHandler: [authGuard] }, async (request, reply) => {
      const { userId, role } = request.user!;
      const list = await consultationsService.listUserConsultations(userId, role);
      return reply.send(list);
    });

    fastify.get('/:consultationId', { preHandler: [authGuard] }, async (request, reply) => {
      const { consultationId } = request.params as { consultationId: string };
      const { userId, role } = request.user!;
      const consultation = await consultationsService.getConsultation(consultationId, userId, role);
      return reply.send(consultation);
    });

    fastify.patch('/:consultationId/status', { preHandler: [authGuard] }, async (request, reply) => {
      const { consultationId } = request.params as { consultationId: string };
      const { userId, role } = request.user!;
      const validated = updateConsultationStatusSchema.parse(request.body);

      const updated = await consultationsService.updateStatus(consultationId, userId, role, validated);
      return reply.send(updated);
    });
  };
}
