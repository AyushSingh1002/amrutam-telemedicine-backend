/**
 * ==============================================================================
 * Amrutam Telemedicine Backend — k6 Concurrency & Idempotency Load Test
 * ==============================================================================
 * Demonstrates:
 * 1. Concurrency double-booking prevention: Multiple VUs race to book the exact same slot.
 *    Result: Exactly ONE booking succeeds (201 Created); all other concurrent VUs get 409 Conflict.
 * 2. Strict Idempotency: Retrying with the same Idempotency-Key returns cached 201 response.
 *
 * Usage:
 *   k6 run test/load/k6-booking-concurrency.js
 * ==============================================================================
 */

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// Custom Metrics
export const bookingSuccessCount = new Counter('booking_success_count');
export const bookingConflictCount = new Counter('booking_conflict_count');
export const idempotencyHitCount = new Counter('idempotency_hit_count');
export const bookingLatencyTrend = new Trend('booking_latency_ms');

export const options = {
  scenarios: {
    // 20 Virtual Users simultaneously racing to book the same slot
    concurrency_race: {
      executor: 'per-vu-iterations',
      vus: 20,
      iterations: 1,
      maxDuration: '30s',
    },
  },
  thresholds: {
    // Exactly 1 winner per test run
    booking_success_count: ['count==1'],
    // Remaining 19 requests must be rejected with 409 Conflict
    booking_conflict_count: ['count==19'],
    http_req_duration: ['p(95)<200'], // 95% of requests under 200ms
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export function setup() {
  // 1. Register a doctor
  const docPayload = JSON.stringify({
    email: `k6.doc.${Date.now()}@amrutam.health`,
    password: 'K6DoctorPassword123!',
    role: 'doctor',
    fullName: 'Dr. K6 Concurrency Benchmark',
    specialty: 'Ayurveda',
    licenseNumber: `LIC-K6-${Date.now()}`
  });

  const docRes = http.post(`${BASE_URL}/api/v1/auth/register`, docPayload, {
    headers: { 'Content-Type': 'application/json' },
  });

  const docData = JSON.parse(docRes.body);
  const docToken = docData.tokens.accessToken;
  const docId = docData.user.id;

  // 2. Doctor publishes 1 availability slot
  const slotPayload = JSON.stringify({
    startTime: '2026-11-15T09:00:00.000Z',
    endTime: '2026-11-15T09:30:00.000Z',
  });

  const slotRes = http.post(`${BASE_URL}/api/v1/doctors/${docId}/slots`, slotPayload, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${docToken}`,
    },
  });

  const slotData = JSON.parse(slotRes.body);
  const targetSlotId = slotData.id;

  // 3. Register a test patient
  const patPayload = JSON.stringify({
    email: `k6.patient.${Date.now()}@example.com`,
    password: 'K6PatientPassword123!',
    role: 'patient',
    fullName: 'K6 Concurrency Patient'
  });

  const patRes = http.post(`${BASE_URL}/api/v1/auth/register`, patPayload, {
    headers: { 'Content-Type': 'application/json' },
  });

  const patData = JSON.parse(patRes.body);
  const patientToken = patData.tokens.accessToken;

  return {
    targetSlotId,
    patientToken,
  };
}

export default function (data) {
  const vuId = __VU;
  const uniqueIdemKey = `k6-idem-vu-${vuId}-${Date.now()}`;

  const payload = JSON.stringify({
    slotId: data.targetSlotId,
    amountCents: 50000,
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${data.patientToken}`,
      'Idempotency-Key': uniqueIdemKey,
    },
  };

  // VUs fire concurrently
  const res = http.post(`${BASE_URL}/api/v1/booking/reserve`, payload, params);
  bookingLatencyTrend.add(res.timings.duration);

  if (res.status === 201) {
    bookingSuccessCount.add(1);
    check(res, {
      'Winner received 201 Created': (r) => r.status === 201,
      'Consultation was scheduled': (r) => JSON.parse(r.body).status === 'scheduled',
    });

    // TEST IDEMPOTENCY: Re-send with the EXACT same Idempotency-Key
    const replayRes = http.post(`${BASE_URL}/api/v1/booking/reserve`, payload, params);
    check(replayRes, {
      'Replay received 201 Created': (r) => r.status === 201,
      'Response has X-Idempotent-Replayed header': (r) =>
        r.headers['X-Idempotent-Replayed'] === 'true',
    });
    idempotencyHitCount.add(1);

  } else if (res.status === 409) {
    bookingConflictCount.add(1);
    check(res, {
      'Loser received 409 Conflict': (r) => r.status === 409,
      'Correct error code returned': (r) =>
        JSON.parse(r.body).error.code === 'SLOT_UNAVAILABLE',
    });
  }
}
