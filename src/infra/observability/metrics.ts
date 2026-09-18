import client from 'prom-client';

// Collect default Node.js and runtime metrics
client.collectDefaultMetrics({ prefix: 'amrutam_' });

// HTTP Request Duration Histogram
export const httpRequestDurationMicroseconds = new client.Histogram({
  name: 'amrutam_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
});

// HTTP Total Request Counter
export const httpRequestsTotal = new client.Counter({
  name: 'amrutam_http_requests_total',
  help: 'Total number of HTTP requests processed',
  labelNames: ['method', 'route', 'status_code']
});

// Active DB Pool Connections Gauge
export const dbPoolActiveConnections = new client.Gauge({
  name: 'amrutam_db_pool_active_connections',
  help: 'Number of active database pool connections in use'
});

// BullMQ Queue Depth Gauge
export const queueJobCountGauge = new client.Gauge({
  name: 'amrutam_queue_job_count',
  help: 'Number of pending/delayed jobs across BullMQ queues',
  labelNames: ['queue_name', 'status']
});

// Idempotent Hits Counter
export const idempotencyCacheHitsTotal = new client.Counter({
  name: 'amrutam_idempotency_cache_hits_total',
  help: 'Number of requests served from idempotency replay cache'
});

export const getMetrics = async (): Promise<string> => {
  return await client.register.metrics();
};

export const getMetricsContentType = (): string => {
  return client.register.contentType;
};
