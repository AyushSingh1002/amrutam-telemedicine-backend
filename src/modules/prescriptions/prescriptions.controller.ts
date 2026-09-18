import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrescriptionsService } from './prescriptions.service';
import { TokenService } from '../auth/token.service';
import { createAuthMiddleware } from '../../middleware/auth';
import { roleGuard } from '../../middleware/rbac';
import { issuePrescriptionSchema } from './prescriptions.schema';

export function createPrescriptionRoutes(
  prescriptionsService: PrescriptionsService,
  tokenService: TokenService
): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    const authGuard = createAuthMiddleware(tokenService);

    fastify.post(
      '/:consultationId/prescription',
      { preHandler: [authGuard, roleGuard(['doctor', 'admin'])] },
      async (request, reply) => {
        const { consultationId } = request.params as { consultationId: string };
        const doctorId = request.user!.userId;
        const validated = issuePrescriptionSchema.parse(request.body);

        const prescription = await prescriptionsService.issuePrescription(
          consultationId,
          doctorId,
          validated
        );
        return reply.status(201).send(prescription);
      }
    );

    fastify.get(
      '/:consultationId/prescription',
      { preHandler: [authGuard] },
      async (request, reply) => {
        const { consultationId } = request.params as { consultationId: string };
        const { userId, role } = request.user!;

        const prescription = await prescriptionsService.getPrescription(
          consultationId,
          userId,
          role
        );
        return reply.send(prescription);
      }
    );
  };
}
