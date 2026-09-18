# Amrutam Telemedicine Backend — Architecture & System Design Document

## 1. Executive Summary & System Goals
The Amrutam Telemedicine Backend is an enterprise-grade, high-concurrency healthcare consultation platform designed to scale reliably toward **100,000 consultations per day** (~1.16 consultations/sec baseline, peak load 10–25 consultations/sec, and 200–500 read/search queries/sec) with **99.95% availability**.

In healthcare and telemedicine platforms, data correctness, non-repudiation, patient privacy (HIPAA/DISHA compliance), and zero double-booking are non-negotiable. This architecture implements:
- **Pessimistic Row-Level Locking (`SELECT FOR UPDATE`)** & unique database constraints to guarantee zero double-booking under concurrent load.
- **Strict Idempotency** on all mutating endpoints (`Idempotency-Key` headers) to eliminate duplicate charges and duplicate reservations.
- **Saga Orchestration Pattern** for booking and payments with automatic compensating transactions (releasing held slots if payment fails).
- **Partitioning & Caching Strategy** (PostgreSQL range partitioning by `created_at` on consultations, Redis cache-aside for doctor search and availability reads).
- **Immutable Audit Trails** (append-only `audit_logs` protected by database role privileges) and **AES-256-GCM field-level encryption** for clinical notes.
- **Comprehensive Observability** (Prometheus metrics, OpenTelemetry distributed tracing, structured correlation logging).

---

## 2. High-Level System Architecture

```mermaid
flowchart TD
    subgraph Clients["Client Layer"]
        Web[Web Patient/Doctor Portal]
        Mobile[Mobile iOS/Android App]
        AdminUI[Admin Analytics Dashboard]
    end

    subgraph Edge["Edge & Security Layer"]
        LB["Cloud Load Balancer / Ingress (TLS Termination, DDoS Guard)"]
        WAF["WAF & Rate Limiting"]
    end

    subgraph AppCluster["Application Cluster (Stateless Fastify Service)"]
        API1["API Instance 1"]
        API2["API Instance 2"]
        APIN["API Instance N"]
    end

    subgraph AsyncWorkers["Background Workers (BullMQ)"]
        Worker1["Notification Worker"]
        Worker2["Reminder Worker"]
        Worker3["Analytics Rollup Worker"]
    end

    subgraph CachingQueue["In-Memory & Messaging (Redis Cluster)"]
        RedisCache["Redis Cache (Doctor Search & Availability)"]
        RedisQueue["Redis Queues (BullMQ Jobs & Dead Letter Queue)"]
    end

    subgraph DataStorage["Data Persistence (PostgreSQL 15+ HA Cluster)"]
        PrimaryDB[("PostgreSQL Primary (Read/Write, Partitioned)")]
        ReplicaDB[("PostgreSQL Read Replica (Analytics & Heavy Queries)")]
    end

    subgraph ExternalProviders["External Gateways (Abstracted Interfaces)"]
        PaymentGW["Payment Gateway (Mock / Razorpay / Stripe)"]
        NotifyGW["Notification Provider (Console / Twilio / SendGrid)"]
        VideoService["Telehealth Video Provider (External Meeting URL)"]
    end

    Clients --> LB
    LB --> WAF
    WAF --> API1 & API2 & APIN

    API1 & API2 & APIN --> RedisCache
    API1 & API2 & APIN --> RedisQueue
    API1 & API2 & APIN --> PrimaryDB
    PrimaryDB -.->|Streaming Replication| ReplicaDB

    RedisQueue --> Worker1 & Worker2 & Worker3
    Worker1 & Worker2 & Worker3 --> PrimaryDB
    Worker1 & Worker2 & Worker3 --> NotifyGW
    API1 & API2 & APIN --> PaymentGW
```

---

## 3. Core Domain Models & Database Design

### 3.1 Relational Schema & Constraints
The database schema enforces referential integrity, concurrency locks, and auditability at the storage engine level.

```mermaid
erDiagram
    USERS ||--|| PROFILES : "has"
    USERS ||--o| DOCTORS : "qualifies as"
    DOCTORS ||--o{ AVAILABILITY_SLOTS : "publishes"
    USERS ||--o{ CONSULTATIONS : "books as patient"
    DOCTORS ||--o{ CONSULTATIONS : "attends as doctor"
    AVAILABILITY_SLOTS ||--o| CONSULTATIONS : "fulfills"
    CONSULTATIONS ||--o{ PRESCRIPTIONS : "generates"
    CONSULTATIONS ||--o| PAYMENTS : "billed via"
    USERS ||--o{ AUDIT_LOGS : "acted by"

    USERS {
        uuid id PK
        string email UK
        string password_hash
        string role "patient | doctor | admin"
        string mfa_secret
        boolean mfa_enabled
        timestamp created_at
        timestamp updated_at
    }

    PROFILES {
        uuid user_id PK,FK
        string full_name
        string phone
        date date_of_birth
        jsonb metadata
    }

    DOCTORS {
        uuid user_id PK,FK
        string specialty
        string license_number
        string[] languages
        numeric rating
    }

    AVAILABILITY_SLOTS {
        uuid id PK
        uuid doctor_id FK
        timestamp start_time
        timestamp end_time
        string status "open | held | booked | cancelled"
    }

    CONSULTATIONS {
        uuid id PK
        uuid patient_id FK
        uuid doctor_id FK
        uuid slot_id FK,UK
        string status "scheduled | in_progress | completed | cancelled | no_show"
        string idempotency_key UK
        int version
        timestamp created_at
    }

    PRESCRIPTIONS {
        uuid id PK
        uuid consultation_id FK
        uuid doctor_id FK
        bytea notes_encrypted
        timestamp issued_at
    }

    PAYMENTS {
        uuid id PK
        uuid consultation_id FK
        int amount_cents
        string currency
        string status "pending | captured | failed | refunded"
        string idempotency_key UK
        string provider_ref
    }

    AUDIT_LOGS {
        bigserial id PK
        uuid actor_id
        string action
        string entity_type
        uuid entity_id
        jsonb before
        jsonb after
        timestamp created_at
    }
```

---

## 4. Concurrency Control & Zero Double-Booking Guarantee

### 4.1 The Race Condition Problem
When multiple patients attempt to book the same doctor's slot simultaneously (e.g., peak morning booking surges), naive `SELECT` followed by `UPDATE` allows two transactions to see the slot as `open`, leading to catastrophic double bookings.

### 4.2 Two-Tiered Prevention Strategy
1. **Tier 1 — Row-Level Pessimistic Locking (`SELECT FOR UPDATE`):**
   Within a PostgreSQL transaction, the booking engine issues:
   ```sql
   SELECT id, doctor_id, start_time, end_time, status
   FROM availability_slots
   WHERE id = $1
   FOR UPDATE;
   ```
   If Transaction B attempts to read the same slot with `FOR UPDATE`, it blocks until Transaction A commits or rolls back. Transaction B then reads the updated status (`booked`) and receives an immediate `409 Conflict: Slot already booked`.

2. **Tier 2 — Database Unique Constraint Guarantee:**
   A unique constraint on `consultations(slot_id)` and `availability_slots(doctor_id, start_time)` ensures that even under network partitioning or unexpected isolation levels, duplicate booking is physically rejected by the database engine.

---

## 5. Saga Workflow: Distributed Booking & Payment Orchestration

The booking and payment flow spans multiple entities: reserving the slot, processing payment, confirming the consultation, and notifying parties. We employ an **Orchestrated Saga Pattern** with forward execution and compensating rollback:

```mermaid
sequenceDiagram
    autonumber
    actor Patient
    participant API as Fastify API
    participant DB as PostgreSQL
    participant PG as Payment Gateway
    participant Queue as BullMQ Queue

    Patient->>API: POST /api/v1/booking/reserve (Slot ID, Idempotency-Key)
    activate API
    API->>DB: BEGIN TX
    API->>DB: SELECT slot FOR UPDATE
    alt Slot is not open
        API->>DB: ROLLBACK
        API-->>Patient: 409 Conflict (Slot unavailable)
    else Slot is open
        API->>DB: UPDATE slot SET status = 'held'
        API->>DB: INSERT consultation (status = 'scheduled')
        API->>DB: INSERT payment (status = 'pending')
        API->>DB: COMMIT TX
        API-->>Patient: 201 Created (Payment Intent / Transaction Ready)
    end
    deactivate API

    Patient->>API: POST /api/v1/booking/confirm (Payment Token)
    activate API
    API->>PG: Charge Payment (Amount, Token)
    alt Payment Succeeded
        PG-->>API: 200 Captured (Charge ID)
        API->>DB: BEGIN TX
        API->>DB: UPDATE payments SET status = 'captured'
        API->>DB: UPDATE availability_slots SET status = 'booked'
        API->>DB: INSERT audit_logs (action = 'BOOKING_CONFIRMED')
        API->>DB: COMMIT TX
        API->>Queue: Enqueue 'consultation-confirmation' job
        API-->>Patient: 200 OK (Consultation Confirmed)
    else Payment Failed (Compensating Transaction)
        PG-->>API: 402 Payment Declined
        API->>DB: BEGIN TX
        API->>DB: UPDATE payments SET status = 'failed'
        API->>DB: UPDATE availability_slots SET status = 'open'
        API->>DB: UPDATE consultations SET status = 'cancelled'
        API->>DB: INSERT audit_logs (action = 'BOOKING_PAYMENT_FAILED_RELEASED')
        API->>DB: COMMIT TX
        API-->>Patient: 402 Payment Failed (Slot Released)
    end
    deactivate API
```

---

## 6. Consultation Lifecycle State Machine & Optimistic Locking

Consultations undergo strict state transitions verified by role authorization:

```mermaid
stateDiagram-v2
    [*] --> scheduled: Patient Books & Confirms
    scheduled --> in_progress: Doctor Starts Consultation
    scheduled --> cancelled: Patient or Doctor Cancels
    scheduled --> no_show: Scheduled Window Passed & Patient Absent
    in_progress --> completed: Doctor Concludes Consultation
    completed --> [*]: Prescription Issued & Audit Complete
    cancelled --> [*]
    no_show --> [*]
```

### Optimistic Locking with Versioning
To prevent race conditions during state transitions (e.g., patient cancelling while doctor starts consultation):
```sql
UPDATE consultations
SET status = $new_status, version = version + 1, updated_at = NOW()
WHERE id = $id AND version = $expected_version;
```
If 0 rows are affected, a `409 Conflict: Concurrent modification detected` is returned, forcing the client to re-fetch the latest consultation state.

---

## 7. PostgreSQL Partitioning Strategy (100k/day Scale)

At **100,000 consultations per day**, the `consultations` table accumulates **36.5 million rows annually**. Index maintenance, vacuuming, and sequential scans on unpartitioned tables degrade performance rapidly.

### Partitioning Scheme: Range Partitioning by `created_at`
The `consultations` table is partitioned monthly using PostgreSQL native declarative partitioning:

```sql
CREATE TABLE consultations (
  id UUID NOT NULL,
  patient_id UUID NOT NULL,
  doctor_id UUID NOT NULL,
  slot_id UUID NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Monthly partition tables created dynamically or ahead of time
CREATE TABLE consultations_y2026m09 PARTITION OF consultations
    FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');

CREATE TABLE consultations_y2026m10 PARTITION OF consultations
    FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');
```

### Benefits:
1. **Partition Pruning:** Queries bounded by date range scan only the active month's child partition, reducing buffer cache pressure by over 90%.
2. **Maintenance Isolation:** `VACUUM ANALYZE` runs efficiently per partition.
3. **Data Archival / Retention:** Partitions older than regulatory requirements (e.g., 7 years) can be detached and archived to cold S3 Parquet storage with zero downtime.

---

## 8. Caching Topology & Invalidation (Redis Cache-Aside)

Doctor search and availability are read-heavy (~95% read, ~5% write). A two-tier caching topology ensures sub-10ms response times:

```mermaid
flowchart LR
    Client[Client Request] --> Fastify[Fastify Router]
    Fastify --> CacheCheck{Redis Cache Hit?}
    CacheCheck -- Yes --> ReturnCached[Return Cached Results 2-5ms]
    CacheCheck -- No --> QueryDB[Query PostgreSQL 30-50ms]
    QueryDB --> StoreCache[Store in Redis TTL: 60s]
    StoreCache --> ReturnFresh[Return Response]

    SlotMutate[Doctor Modifies Availability / Booking] --> Invalidate[Evict Related Redis Keys]
    Invalidate --> RedisCache[(Redis Cache)]
```

- **Cache Keys:**
  - `doctor:search:<hash_of_query_params>` (TTL: 60s)
  - `doctor:slots:<doctor_id>:<date>` (TTL: 30s)
- **Targeted Invalidation:** Whenever a doctor adds a slot or a slot is booked/cancelled, the event triggers an invalidation hook targeting `doctor:slots:<doctor_id>:*` and general search cache tags.

---

## 9. Asynchronous Job Processing & Dead Letter Queues (BullMQ)

Heavy and out-of-band operations are decoupled from HTTP request cycles:
- **`notifications-queue`**: Sends SMS/email appointment confirmations and prescription alerts.
- **`reminders-queue`**: Scheduled delayed jobs triggering 15 minutes before consultation.
- **`analytics-rollup-queue`**: Computes hourly aggregate stats (consultations count, no-show rate, utilization) and writes to pre-aggregated tables to keep admin endpoints instantaneous.

**Reliability Controls:**
- Exponential backoff with jitter (`attempts: 5, backoff: { type: 'exponential', delay: 2000 }`).
- Dead Letter Queue (`DLQ`) for failed payloads after max retries for manual inspection and alerting.

---

## 10. Disaster Recovery (DR) & Business Continuity Plan

| Metric | Target | Strategy |
|---|---|---|
| **Recovery Point Objective (RPO)** | $\le 1 \text{ minute}$ | WAL archiving (pgBackRest / AWS WAL-G) to Amazon S3 every 60 seconds with continuous replication to standby. |
| **Recovery Time Objective (RTO)** | $\le 15 \text{ minutes}$ | Automated Patroni failover for PostgreSQL cluster; automated DNS failover (Route 53 latency routing). |
| **Data Retention** | 7 Years (HIPAA Compliance) | Detached annual table partitions archived to immutable AWS S3 Glacier with Object Lock. |

---

## 11. Infrastructure Mapping (Docker Compose to Kubernetes / ECS)

While the MVP runs cleanly locally via `docker-compose.yml`, the architecture maps directly to production cloud orchestrators:

- **Fastify API:** Deployed as Kubernetes `Deployment` (or AWS ECS Fargate Tasks) with Horizontal Pod Autoscaler (HPA) targeting 70% CPU / memory utilization.
- **Statelessness:** The API stores zero local state; session state resides in signed JWTs and Redis.
- **Ingress:** Kubernetes NGINX Ingress Controller / AWS ALB with TLS 1.3 termination, rate limiting, and WAF rules.
- **Background Workers:** Deployed as separate Kubernetes `Deployment` workers scaling on BullMQ queue depth metrics via KEDA (Kubernetes Event-driven Autoscaling).
- **PostgreSQL:** Managed AWS Aurora PostgreSQL Multi-AZ or Cloud SQL with automated storage scaling and read replicas.
- **Redis:** AWS ElastiCache for Redis Cluster with Multi-AZ automated failover.
