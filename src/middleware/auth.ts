import { FastifyRequest, FastifyReply } from 'fastify';
import { TokenService, TokenPayload } from '../modules/auth/token.service';

declare module 'fastify' {
  interface FastifyRequest {
    user?: TokenPayload;
  }
}

export function createAuthMiddleware(tokenService: TokenService) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Missing or malformed Authorization header with Bearer token'
        }
      });
    }

    const token = authHeader.substring(7);
    try {
      const payload = tokenService.verifyAccessToken(token);
      request.user = payload;
    } catch {
      return reply.status(401).send({
        error: {
          code: 'INVALID_TOKEN',
          message: 'Access token is invalid or expired'
        }
      });
    }
  };
}
