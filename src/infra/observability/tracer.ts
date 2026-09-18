import { trace, context, Span, Tracer } from '@opentelemetry/api';
import { config } from '../../config/env';

export const tracer: Tracer = trace.getTracer(config.OTEL_SERVICE_NAME, '1.0.0');

export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes?: Record<string, string | number | boolean>
): Promise<T> {
  const span = tracer.startSpan(name);
  if (attributes) {
    span.setAttributes(attributes);
  }

  try {
    const result = await context.with(trace.setSpan(context.active(), span), () => fn(span));
    span.setStatus({ code: 1 }); // OK
    return result;
  } catch (error) {
    span.recordException(error as Error);
    span.setStatus({ code: 2, message: (error as Error).message }); // ERROR
    throw error;
  } finally {
    span.end();
  }
}
