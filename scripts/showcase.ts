import { buildApp } from '../src/app';
import { InMemoryDatabase } from '../src/infra/db/in-memory-db';
import { MemoryCacheService } from '../src/infra/cache/memory-cache';
import { MemoryQueueService } from '../src/infra/queue/memory-queue';

process.env.LOG_LEVEL = 'error';

function printTitle() {
  console.log('\n========================================');
  console.log('  Amrutam Telemedicine Backend Demo');
  console.log('========================================');
  console.log('This walkthrough exercises the core flows:');
  console.log('  1. Registration');
  console.log('  2. Slot publishing');
  console.log('  3. Search + booking');
  console.log('  4. Payment confirmation');
  console.log('  5. Analytics overview');
  console.log('========================================\n');
}

function printStep(step: string, label: string) {
  console.log(`\n[${step}] ${label}`);
  console.log('----------------------------------------');
}

function printResult(label: string, value: unknown) {
  console.log(`${label}: ${JSON.stringify(value, null, 2)}`);
}

async function runShowcase() {
  printTitle();

  const db = new InMemoryDatabase();
  const cache = new MemoryCacheService();
  const queue = new MemoryQueueService();

  const app = await buildApp({ db, cache, queue });
  await app.ready();

  try {
    printStep('1', 'Registering doctor, patient, and admin');

    const doctorRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'dr.sharma@amrutam.health',
        password: 'SecurePassword123!',
        role: 'doctor',
        fullName: 'Dr. Aarav Sharma',
        phone: '+919811122233',
        specialty: 'Ayurveda',
        licenseNumber: 'AYU-DEL-2024-9981',
        languages: ['English', 'Hindi']
      }
    });

    const patientRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'patient.neha@example.com',
        password: 'PatientPassword123!',
        role: 'patient',
        fullName: 'Neha Verma',
        phone: '+919877788899'
      }
    });

    const adminRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'admin.super@amrutam.health',
        password: 'AdminPassword123!',
        role: 'admin',
        fullName: 'Chief Medical Operations'
      }
    });

    const doctorBody = JSON.parse(doctorRes.payload);
    const patientBody = JSON.parse(patientRes.payload);
    const adminBody = JSON.parse(adminRes.payload);

    printResult('Doctor', { id: doctorBody.user.id, email: doctorBody.user.email, role: doctorBody.user.role });
    printResult('Patient', { id: patientBody.user.id, email: patientBody.user.email, role: patientBody.user.role });
    printResult('Admin', { id: adminBody.user.id, email: adminBody.user.email, role: adminBody.user.role });

    const doctorToken = doctorBody.tokens.accessToken;
    const patientToken = patientBody.tokens.accessToken;
    const adminToken = adminBody.tokens.accessToken;
    const doctorId = doctorBody.user.id;

    printStep('2', 'Publishing a doctor availability slot');
    const slotRes = await app.inject({
      method: 'POST',
      url: `/api/v1/doctors/${doctorId}/slots`,
      headers: { authorization: `Bearer ${doctorToken}` },
      payload: {
        startTime: '2026-10-25T09:00:00.000Z',
        endTime: '2026-10-25T09:30:00.000Z'
      }
    });
    const slotBody = JSON.parse(slotRes.payload);
    printResult('Published slot', {
      id: slotBody.id,
      doctorId: slotBody.doctorId,
      startTime: slotBody.startTime,
      endTime: slotBody.endTime,
      status: slotBody.status
    });

    printStep('3', 'Searching for doctors and booking a slot');
    const searchRes = await app.inject({
      method: 'GET',
      url: '/api/v1/search/doctors?specialty=Ayurveda&language=Hindi&minRating=4&page=1&limit=10'
    });
    const searchBody = JSON.parse(searchRes.payload);
    printResult('Search result', {
      total: searchBody.total,
      cached: searchBody.cached,
      doctor: searchBody.doctors?.[0]?.profile?.fullName || 'n/a'
    });

    const reserveRes = await app.inject({
      method: 'POST',
      url: '/api/v1/booking/reserve',
      headers: {
        authorization: `Bearer ${patientToken}`,
        'idempotency-key': 'showcase-reserve-key'
      },
      payload: {
        slotId: slotBody.id,
        amountCents: 50000
      }
    });

    const reserveBody = JSON.parse(reserveRes.payload);
    printResult('Reservation response', {
      consultationId: reserveBody.consultationId,
      slotId: reserveBody.slotId,
      status: reserveBody.status,
      paymentStatus: reserveBody.payment?.status
    });

    printStep('4', 'Confirming payment');
    const confirmRes = await app.inject({
      method: 'POST',
      url: '/api/v1/booking/confirm',
      headers: {
        authorization: `Bearer ${patientToken}`,
        'idempotency-key': 'showcase-confirm-key'
      },
      payload: {
        consultationId: reserveBody.consultationId,
        paymentSuccess: true
      }
    });

    const confirmBody = JSON.parse(confirmRes.payload);
    printResult('Confirmation result', {
      consultationId: confirmBody.consultationId,
      status: confirmBody.status,
      paymentStatus: confirmBody.paymentStatus,
      providerRef: confirmBody.providerRef
    });

    printStep('5', 'Checking admin analytics');
    const analyticsRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/analytics',
      headers: { authorization: `Bearer ${adminToken}` }
    });

    const analyticsBody = JSON.parse(analyticsRes.payload);
    printResult('Analytics summary', {
      totalConsultations: analyticsBody.totalConsultations,
      totalDoctors: analyticsBody.totalDoctors,
      totalPatients: analyticsBody.totalPatients,
      noShowRatePercentage: analyticsBody.noShowRatePercentage,
      source: analyticsBody.source
    });

    console.log('\n========================================');
    console.log('  Showcase completed successfully');
    console.log('========================================');
    console.log('The app successfully demonstrated the core healthcare workflow.');
    console.log('Press Ctrl+C to exit the terminal.');
  } finally {
    await app.close();
  }
}

runShowcase().catch((err) => {
  console.error('Showcase failed:', err);
  process.exit(1);
});
