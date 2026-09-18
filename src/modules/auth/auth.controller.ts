import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { registerSchema, loginSchema, refreshTokenSchema, mfaVerifySchema } from './auth.schema';
import { createAuthMiddleware } from '../../middleware/auth';

export function createAuthRoutes(authService: AuthService, tokenService: TokenService): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    const authGuard = createAuthMiddleware(tokenService);

    fastify.post('/register', async (request, reply) => {
      const validated = registerSchema.parse(request.body);
      const result = await authService.register(validated);
      return reply.status(201).send(result);
    });

    fastify.post('/login', async (request, reply) => {
      const validated = loginSchema.parse(request.body);
      const result = await authService.login(validated);
      return reply.status(200).send(result);
    });

    fastify.post('/refresh', async (request, reply) => {
      const validated = refreshTokenSchema.parse(request.body);
      const tokens = await authService.refreshToken(validated.refreshToken);
      return reply.status(200).send({ tokens });
    });

    fastify.post('/mfa/setup', { preHandler: [authGuard] }, async (request, reply) => {
      const userId = request.user!.userId;
      const result = await authService.setupMfa(userId);
      return reply.status(200).send(result);
    });

    fastify.post('/mfa/verify', { preHandler: [authGuard] }, async (request, reply) => {
      const userId = request.user!.userId;
      const validated = mfaVerifySchema.parse(request.body);
      await authService.verifyAndEnableMfa(userId, validated.token);
      return reply.status(200).send({ success: true, message: 'MFA enabled successfully' });
    });
  };
}
