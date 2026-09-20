# Amrutam Telemedicine Backend — API Endpoints & Practical Showcase Guide

This document is the complete reference and practical showcase for the Amrutam Telemedicine Backend REST API. It details all endpoints, request/response contracts, header specifications, and step-by-step practical execution scenarios demonstrating:
- **Zero Double-Booking (Pessimistic Row-Level Locking)**
- **Strict Idempotency Replay (`X-Idempotent-Replayed: true`)**
- **Two-Phase Saga Payment & Compensating Slot Rollback**
- **Optimistic Locking with Version Conflict Detection**
- **AES-256-GCM Authenticated Encryption for Clinical Notes**
- **Role-Based Access Control (RBAC) Security Guards**
- **Prometheus Metrics & Kubernetes Readiness Probes**

---

## 1. Quick Reference: API Endpoint Catalog

| Module | Method | Endpoint Path | Auth Required | Idempotent | Description |
|---|:---:|---|:---:|:---:|---|
| **System** | `GET` | `/healthz` | No | Yes | Kubernetes liveness probe |
| **System** | `GET` | `/readyz` | No | Yes | Kubernetes readiness probe (checks DB & Redis) |
| **System** | `GET` | `/metrics` | No | Yes | Prometheus scrape endpoint |
| **Auth** | `POST` | `/api/v1/auth/register` | No | No | Register Patient, Doctor, or Admin |
| **Auth** | `POST` | `/api/v1/auth/login` | No | No | Authenticate credentials & issue JWT tokens |
| **Auth** | `POST` | `/api/v1/auth/refresh` | No | No | Rotate refresh token with reuse detection |
| **Auth** | `POST` | `/api/v1/auth/mfa/setup` | Yes | No | Generate TOTP secret & QR code data URI |
| **Auth** | `POST` | `/api/v1/auth/mfa/verify` | Yes | No | Verify 6-digit TOTP code and enable MFA |
| **Doctors** | `GET` | `/api/v1/doctors/:doctorId` | No | Yes | Fetch doctor public profile |
| **Doctors** | `POST` | `/api/v1/doctors/:doctorId/slots` | Doctor | No | Doctor publishes availability slot |
| **Doctors** | `GET` | `/api/v1/doctors/:doctorId/slots` | No | Yes | Get open availability slots for doctor |
| **Search** | `GET` | `/api/v1/search/doctors` | No | Yes | Multi-criteria search (cached in Redis, 60s TTL) |
| **Booking** | `POST` | `/api/v1/booking/reserve` | Patient | **Required** | Saga Step 1: Hold slot & schedule consultation |
| **Booking** | `POST` | `/api/v1/booking/confirm` | Patient | **Required** | Saga Step 2: Charge payment or compensate & release |
| **Consultations** | `GET` | `/api/v1/consultations` | Yes | Yes | List authenticated user's consultations |
| **Consultations** | `GET` | `/api/v1/consultations/:id` | Assigned | Yes | Get single consultation details |
| **Consultations** | `PATCH` | `/api/v1/consultations/:id/status`| Assigned | No | State machine advance with optimistic locking |
| **Prescriptions** | `POST` | `/api/v1/consultations/:id/prescription` | Doctor | No | Issue prescription with AES-256-GCM encryption |
| **Prescriptions** | `GET` | `/api/v1/consultations/:id/prescription` | Assigned | Yes | Retrieve & decrypt prescription notes |
| **Admin** | `GET` | `/api/v1/admin/analytics` | Admin | Yes | Platform rollup stats (cached 1hr) |
| **Admin** | `GET` | `/api/v1/admin/audit-logs` | Admin | Yes | Paginated immutable audit trail query |

---

## 2. Standard Request & Response Conventions

### Required Headers for Mutating Operations
```http
Content-Type: application/json
Authorization: Bearer <JWT_ACCESS_TOKEN>
Idempotency-Key: <UUID_OR_UNIQUE_STRING>
X-Request-Id: <OPTIONAL_CLIENT_CORRELATION_ID>
```

### Standard Success Response Envelope
```json
{
  "status": "success",
  "data": { ... }
}
```
*(Or domain entity directly with appropriate HTTP status: `200 OK`, `201 Created`)*

### Standard Error Response Envelope (RFC 7807 Aligned)
```json
{
  "error": {
    "code": "SLOT_UNAVAILABLE",
    "message": "This slot is already booked, held by another patient, or not open",
    "details": []
  }
}
```

---

## 3. Practical Showcase: Step-by-Step Workflows

Below is the practical, reproducible execution sequence using standard `curl` commands (ready to paste into PowerShell or Bash).

---

### Showcase 1: User Registration & Authentication

#### 1.1 Register a Doctor
```bash
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "dr.sharma@amrutam.health",
    "password": "SecurePassword123!",
    "role": "doctor",
    "fullName": "Dr. Aarav Sharma",
    "phone": "+919811122233",
    "specialty": "Ayurveda",
    "licenseNumber": "AYU-DEL-2024-9981",
    "languages": ["English", "Hindi"]
  }'
```
**Expected Response (`201 Created`):**
```json
{
  "user": {
    "id": "d001-uuid",
    "email": "dr.sharma@amrutam.health",
    "role": "doctor",
    "fullName": "Dr. Aarav Sharma",
    "mfaEnabled": false
  },
  "tokens": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresIn": 900
  }
}
```

#### 1.2 Register a Patient
```bash
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "patient.neha@example.com",
    "password": "PatientPassword123!",
    "role": "patient",
    "fullName": "Neha Verma",
    "phone": "+919877788899"
  }'
```

#### 1.3 Register an Admin
```bash
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin.super@amrutam.health",
    "password": "AdminPassword123!",
    "role": "admin",
    "fullName": "Chief Medical Operations"
  }'
```

---

### Showcase 2: TOTP Multi-Factor Authentication (MFA) Setup & Verification

#### 2.1 Initiate MFA Setup (Generates QR Code URI & Secret)
```bash
curl -X POST http://localhost:3000/api/v1/auth/mfa/setup \
  -H "Authorization: Bearer <PATIENT_TOKEN>"
```
**Expected Response (`200 OK`):**
```json
{
  "secret": "JBSWY3DPEHPK3PXP",
  "otpauthUrl": "otpauth://totp/AmrutamTelemedicine:patient.neha@example.com?secret=JBSWY3DPEHPK3PXP&issuer=AmrutamTelemedicine",
  "qrCodeDataUrl": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
}
```

#### 2.2 Verify and Activate MFA
```bash
curl -X POST http://localhost:3000/api/v1/auth/mfa/verify \
  -H "Authorization: Bearer <PATIENT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "481920"
  }'
```
**Expected Response (`200 OK`):**
```json
{
  "success": true,
  "message": "MFA enabled successfully"
}
```

---

### Showcase 3: Doctor Publishes Availability Slots

```bash
curl -X POST http://localhost:3000/api/v1/doctors/<DOCTOR_ID>/slots \
  -H "Authorization: Bearer <DOCTOR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "startTime": "2026-10-25T09:00:00.000Z",
    "endTime": "2026-10-25T09:30:00.000Z"
  }'
```
**Expected Response (`201 Created`):**
```json
{
  "id": "slot-uuid-101",
  "doctorId": "d001-uuid",
  "startTime": "2026-10-25T09:00:00.000Z",
  "endTime": "2026-10-25T09:30:00.000Z",
  "status": "open"
}
```
*Note: This automatically invalidates any existing Redis search and slot caches.*

---

### Showcase 4: Multi-Criteria Doctor Search (Redis Cache-Aside)

```bash
curl -X GET "http://localhost:3000/api/v1/search/doctors?specialty=Ayurveda&language=Hindi&minRating=4&page=1&limit=10"
```
**First Request Response (`200 OK`, Cache Miss):**
```json
{
  "doctors": [
    {
      "userId": "d001-uuid",
      "specialty": "Ayurveda",
      "licenseNumber": "AYU-DEL-2024-9981",
      "languages": ["English", "Hindi"],
      "rating": 5.0,
      "profile": {
        "fullName": "Dr. Aarav Sharma"
      }
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 10,
  "totalPages": 1,
  "cached": false
}
```
**Second Request (Executed within 60 seconds):**
```json
{
  "doctors": [ ... ],
  "total": 1,
  "page": 1,
  "limit": 10,
  "totalPages": 1,
  "cached": true
}
```
*Notice `"cached": true` — served in under 3ms directly from Redis!*

---

### Showcase 5: Zero Double-Booking Concurrency Test (Pessimistic Row Lock)

Demonstrates how two patients competing for the same slot simultaneously are handled without double booking:

```bash
# Patient A reserves the slot
curl -i -X POST http://localhost:3000/api/v1/booking/reserve \
  -H "Authorization: Bearer <PATIENT_A_TOKEN>" \
  -H "Idempotency-Key: reserve-key-patient-a" \
  -H "Content-Type: application/json" \
  -d '{
    "slotId": "slot-uuid-101",
    "amountCents": 50000
  }'
```
**Patient A Response (`201 Created`):**
```json
{
  "consultationId": "consultation-uuid-201",
  "slotId": "slot-uuid-101",
  "status": "scheduled",
  "payment": {
    "id": "pay-uuid-301",
    "amountCents": 50000,
    "currency": "INR",
    "status": "pending"
  }
}
```

```bash
# Patient B attempts to book the SAME slot concurrently
curl -i -X POST http://localhost:3000/api/v1/booking/reserve \
  -H "Authorization: Bearer <PATIENT_B_TOKEN>" \
  -H "Idempotency-Key: reserve-key-patient-b" \
  -H "Content-Type: application/json" \
  -d '{
    "slotId": "slot-uuid-101",
    "amountCents": 50000
  }'
```
**Patient B Response (`409 Conflict`):**
```json
{
  "error": {
    "code": "SLOT_UNAVAILABLE",
    "message": "This slot is already booked, held by another patient, or not open"
  }
}
```
*Pessimistic row-level lock (`SELECT FOR UPDATE`) prevented race conditions. Exactly 1 winner.*

---

### Showcase 6: Idempotent Request Replay (`X-Idempotent-Replayed`)

If a network glitch causes Patient A's client to retry the identical reservation request:
```bash
# Re-run Patient A's identical request with the same Idempotency-Key
curl -i -X POST http://localhost:3000/api/v1/booking/reserve \
  -H "Authorization: Bearer <PATIENT_A_TOKEN>" \
  -H "Idempotency-Key: reserve-key-patient-a" \
  -H "Content-Type: application/json" \
  -d '{
    "slotId": "slot-uuid-101",
    "amountCents": 50000
  }'
```
**Response Headers & Body (`201 Created`):**
```http
HTTP/1.1 201 Created
X-Idempotent-Replayed: true
Content-Type: application/json; charset=utf-8

{
  "consultationId": "consultation-uuid-201",
  "slotId": "slot-uuid-101",
  "status": "scheduled",
  "payment": {
    "id": "pay-uuid-301",
    "amountCents": 50000,
    "currency": "INR",
    "status": "pending"
  }
}
```
*Notice header `X-Idempotent-Replayed: true`. No duplicate record or side effect was executed.*

---

### Showcase 7: Two-Phase Saga Payment & Compensating Rollback

#### Scenario 7.1: Payment Declined $\rightarrow$ Compensating Action Releases Slot
```bash
curl -i -X POST http://localhost:3000/api/v1/booking/confirm \
  -H "Authorization: Bearer <PATIENT_TOKEN>" \
  -H "Idempotency-Key: confirm-fail-key-001" \
  -H "Content-Type: application/json" \
  -d '{
    "consultationId": "consultation-uuid-201",
    "paymentSuccess": false,
    "forceFail": true
  }'
```
**Expected Response (`402 Payment Required`):**
```json
{
  "error": {
    "code": "PAYMENT_FAILED",
    "message": "Card declined: Insufficient funds or fraud suspicion"
  }
}
```
**System Compensating Actions Executed in DB:**
1. `payments.status` updated to `'failed'`.
2. `availability_slots.status` released from `'held'` back to `'open'`.
3. `consultations.status` transitioned to `'cancelled'`.
4. Audit trail entry written: `BOOKING_PAYMENT_FAILED_SLOT_RELEASED`.
5. Redis cache for doctor availability evicted.

#### Scenario 7.2: Successful Payment $\rightarrow$ Forward Saga Confirmation
```bash
# Re-booking after slot is released
curl -X POST http://localhost:3000/api/v1/booking/reserve \
  -H "Authorization: Bearer <PATIENT_TOKEN>" \
  -H "Idempotency-Key: retry-reserve-key-002" \
  -H "Content-Type: application/json" \
  -d '{ "slotId": "slot-uuid-101", "amountCents": 50000 }'

# Confirm Payment
curl -X POST http://localhost:3000/api/v1/booking/confirm \
  -H "Authorization: Bearer <PATIENT_TOKEN>" \
  -H "Idempotency-Key: confirm-success-key-002" \
  -H "Content-Type: application/json" \
  -d '{
    "consultationId": "consultation-uuid-202",
    "paymentSuccess": true
  }'
```
**Expected Response (`200 OK`):**
```json
{
  "consultationId": "consultation-uuid-202",
  "status": "scheduled",
  "paymentStatus": "captured",
  "providerRef": "mock_ch_39f28a01-..."
}
```
*In the background, BullMQ automatically enqueued the appointment confirmation email and reminder jobs.*

---

### Showcase 8: Consultation State Machine & Optimistic Locking

#### 8.1 Doctor Starts Consultation (`scheduled` $\rightarrow$ `in_progress`)
```bash
curl -X PATCH http://localhost:3000/api/v1/consultations/<CONSULTATION_ID>/status \
  -H "Authorization: Bearer <DOCTOR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "in_progress",
    "expectedVersion": 1
  }'
```
**Expected Response (`200 OK`):**
```json
{
  "id": "consultation-uuid-202",
  "status": "in_progress",
  "version": 2
}
```

#### 8.2 Optimistic Lock Conflict (Client Passes Stale Version)
```bash
# Client passes outdated expectedVersion 1
curl -i -X PATCH http://localhost:3000/api/v1/consultations/<CONSULTATION_ID>/status \
  -H "Authorization: Bearer <DOCTOR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "completed",
    "expectedVersion": 1
  }'
```
**Expected Response (`409 Conflict`):**
```json
{
  "error": {
    "code": "CONCURRENCY_CONFLICT",
    "message": "Version conflict: Consultation was modified concurrently. Expected version 1, but current state does not match."
  }
}
```

#### 8.3 Doctor Completes Consultation (With Valid Version 2)
```bash
curl -X PATCH http://localhost:3000/api/v1/consultations/<CONSULTATION_ID>/status \
  -H "Authorization: Bearer <DOCTOR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "completed",
    "expectedVersion": 2
  }'
```
**Expected Response (`200 OK`):**
```json
{
  "id": "consultation-uuid-202",
  "status": "completed",
  "version": 3
}
```

---

### Showcase 9: AES-256-GCM Encrypted Clinical Prescriptions

#### 9.1 Doctor Issues Prescription (Encrypted at Rest)
```bash
curl -X POST http://localhost:3000/api/v1/consultations/<CONSULTATION_ID>/prescription \
  -H "Authorization: Bearer <DOCTOR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "clinicalNotes": "Patient has aggravated Vata dosha causing insomnia and joints stiffness. Advise Ashwagandha and Yograj Guggulu.",
    "medications": [
      {
        "name": "Ashwagandha Tablet",
        "dosage": "500mg",
        "frequency": "Twice daily after meals",
        "duration": "30 days"
      },
      {
        "name": "Yograj Guggulu",
        "dosage": "250mg",
        "frequency": "Once daily with warm water",
        "duration": "15 days"
      }
    ]
  }'
```
**Expected Response (`201 Created`):**
```json
{
  "id": "rx-uuid-401",
  "consultationId": "consultation-uuid-202",
  "doctorId": "d001-uuid",
  "clinicalNotes": "Patient has aggravated Vata dosha...",
  "medications": [ ... ],
  "issuedAt": "2026-10-25T09:25:00.000Z"
}
```

#### 9.2 Verification of Storage Encryption
In the database, the `notes_encrypted` column stores `[12-byte IV] + [16-byte AuthTag] + [Ciphertext]`. Querying the database row returns binary ciphertext with zero leakage of PHI.

#### 9.3 Patient Views Decrypted Prescription
```bash
curl -X GET http://localhost:3000/api/v1/consultations/<CONSULTATION_ID>/prescription \
  -H "Authorization: Bearer <PATIENT_TOKEN>"
```
**Expected Response (`200 OK`):**
The authenticated patient receives transparently decrypted clinical notes. Any other patient receives `403 Forbidden`.

---

### Showcase 10: Admin Analytics Rollup & Immutable Audit Logs

#### 10.1 Admin Analytics Rollup (Cached Materialization)
```bash
curl -X GET http://localhost:3000/api/v1/admin/analytics \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```
**Expected Response (`200 OK`):**
```json
{
  "consultationsPerDay": 42,
  "noShowRatePercentage": 4.76,
  "averageTimeToBookHours": 2.4,
  "doctorUtilizationPercentage": 78.5,
  "totalConsultations": 42,
  "totalDoctors": 12,
  "totalPatients": 150,
  "source": "cached_rollup"
}
```

#### 10.2 Admin Inspects Immutable Audit Trail
```bash
curl -X GET "http://localhost:3000/api/v1/admin/audit-logs?limit=5" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```
**Expected Response (`200 OK`):**
```json
[
  {
    "id": 105,
    "actorId": "d001-uuid",
    "action": "PRESCRIPTION_ISSUED",
    "entityType": "Prescription",
    "entityId": "rx-uuid-401",
    "before": null,
    "after": {
      "consultationId": "consultation-uuid-202",
      "medicationCount": 2
    },
    "createdAt": "2026-10-25T09:25:00.000Z"
  },
  {
    "id": 104,
    "actorId": "d001-uuid",
    "action": "CONSULTATION_STATUS_COMPLETED",
    "entityType": "Consultation",
    "entityId": "consultation-uuid-202",
    "before": { "status": "in_progress", "version": 2 },
    "after": { "status": "completed", "version": 3 },
    "createdAt": "2026-10-25T09:24:00.000Z"
  }
]
```

---

### Showcase 11: RBAC Security Guard Enforcements

```bash
# Patient attempts to publish doctor availability slots -> 403 Forbidden
curl -i -X POST http://localhost:3000/api/v1/doctors/<DOCTOR_ID>/slots \
  -H "Authorization: Bearer <PATIENT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{ "startTime": "2026-10-25T10:00:00.000Z", "endTime": "2026-10-25T10:30:00.000Z" }'
```
**Response (`403 Forbidden`):**
```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "Access denied. Requires one of roles: [doctor, admin]. Current role: patient"
  }
}
```

```bash
# Patient attempts to access Admin Analytics -> 403 Forbidden
curl -i -X GET http://localhost:3000/api/v1/admin/analytics \
  -H "Authorization: Bearer <PATIENT_TOKEN>"
```
**Response (`403 Forbidden`):**
```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "Access denied. Requires one of roles: [admin]. Current role: patient"
  }
}
```

```bash
# Request without Authorization Header -> 401 Unauthorized
curl -i -X GET http://localhost:3000/api/v1/admin/analytics
```
**Response (`401 Unauthorized`):**
```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Missing or malformed Authorization header with Bearer token"
  }
}
```

---

### Showcase 12: Real-Time Prometheus Metrics & Health Probes

```bash
# Liveness probe
curl http://localhost:3000/healthz

# Readiness probe (verifies PostgreSQL and Redis)
curl http://localhost:3000/readyz

# Prometheus metrics
curl http://localhost:3000/metrics
```
**Prometheus Output Sample:**
```
# HELP amrutam_http_requests_total Total number of HTTP requests processed
# TYPE amrutam_http_requests_total counter
amrutam_http_requests_total{method="POST",route="/api/v1/booking/reserve",status_code="201"} 1
amrutam_http_requests_total{method="POST",route="/api/v1/booking/reserve",status_code="409"} 14

# HELP amrutam_idempotency_cache_hits_total Number of requests served from idempotency replay cache
# TYPE amrutam_idempotency_cache_hits_total counter
amrutam_idempotency_cache_hits_total 1

# HELP amrutam_http_request_duration_seconds Duration of HTTP requests in seconds
# TYPE amrutam_http_request_duration_seconds histogram
amrutam_http_request_duration_seconds_bucket{le="0.05",method="POST",route="/api/v1/booking/reserve",status_code="201"} 1
```

---

## 4. Run the Automated Live Showcase

To see all of the above scenarios executed in an automated live sequence with formatted terminal output:

```bash
# Inside amrutam-telemedicine-backend/
npm run showcase
```

