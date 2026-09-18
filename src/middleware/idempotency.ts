import { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import { IDatabase } from '../infra/db/database.interface';
import { idempotencyCacheHitsTotal } from '../infra/observability/metrics';

export function createIdempotencyMiddleware(db: IDatabase, required: boolean = true) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const idempotencyKey = request.headers['idempotency-key'] as string | undefined;

    if (!idempotencyKey) {
      if (required) {
        return reply.status(400).send({
          error: {
            code: 'MISSING_IDEMPOTENCY_KEY',
            message: 'An Idempotency-Key header is required for this operation'
          }
        });
      }
      return;
    }

    const payload = JSON.stringify(request.body || {});
    const requestHash = crypto
      .createHash('sha256')
      .update(`${request.method}:${request.url}:${payload}`)
      .digest('hex');

    const existing = await db.idempotency.get(idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return reply.status(422).send({
          error: {
            code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
            message: 'This Idempotency-Key was already used with different request parameters'
          }
        });
      }

      idempotencyCacheHitsTotal.inc();
      reply.header('X-Idempotent-Replayed', 'true');
      return reply.status(existing.responseCode).send(existing.responseBody);
    }

    // Attach hook to save the response upon completion
    const originalSend = reply.send.bind(reply);
    reply.send = function (payload: any) {
      // Only cache successful 2xx or 4xx responses, not 5xx internal server errors
      if (reply.statusCode >= 200 && reply.statusCode < 500) {
        let parsedBody = payload;
        if (typeof payload === 'string') {
          try {
            parsedBody = JSON.parse(payload);
          } catch {
            parsedBody = { raw: payload };
          }
        }

        const expiresAt = new Date(Date.now() + 24 * 3600 * 1000); // 24h
        db.idempotency.save({
          key: idempotencyKey,
          requestHash,
          responseCode: reply.statusCode,
          responseBody: parsedBody,
          createdAt: new Date(),
          expiresAt
        }).catch(() => {});
      }

      return originalSend(payload);
    };
  };
}
