import { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { logger } from '../infra/observability/logger';

export function errorHandler(error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) {
  const correlationId = request.headers['x-request-id'] || 'no-id';

  // Handle Zod Schema Validation Errors
  if (error instanceof ZodError) {
    logger.warn({ correlationId, issues: error.issues }, 'Request validation failed');
    return reply.status(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request parameters',
        details: error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message
        }))
      }
    });
  }

  // Handle known HTTP status codes or custom application errors
  const statusCode = (error as any).statusCode || ((error as any).status ? (error as any).status : 500);

  if (statusCode >= 500) {
    logger.error({ correlationId, err: error.message, stack: error.stack }, 'Unhandled internal server error');
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected internal server error occurred. Please try again later.'
      }
    });
  }

  logger.warn({ correlationId, statusCode, message: error.message }, 'Client error encountered');
  return reply.status(statusCode).send({
    error: {
      code: (error as any).code || 'BAD_REQUEST',
      message: error.message
    }
  });
}
