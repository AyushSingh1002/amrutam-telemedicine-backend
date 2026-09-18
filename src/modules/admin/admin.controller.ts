import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { AdminService } from './admin.service';
import { TokenService } from '../auth/token.service';
import { createAuthMiddleware } from '../../middleware/auth';
import { roleGuard } from '../../middleware/rbac';
import { auditLogsQuerySchema } from './admin.schema';

export function createAdminRoutes(adminService: AdminService, tokenService: TokenService): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    const authGuard = createAuthMiddleware(tokenService);
    const adminOnly = roleGuard(['admin']);

    fastify.get('/analytics', { preHandler: [authGuard, adminOnly] }, async (_request, reply) => {
      const stats = await adminService.getAnalytics();
      return reply.send(stats);
    });

    fastify.get('/audit-logs', { preHandler: [authGuard, adminOnly] }, async (request, reply) => {
      const validated = auditLogsQuerySchema.parse(request.query);
      const logs = await adminService.getAuditLogs(validated);
      return reply.send(logs);
    });
  };
}
