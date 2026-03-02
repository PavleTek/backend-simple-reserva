#!/usr/bin/env node
/**
 * API smoke test - verifies all main endpoints respond correctly.
 * Run: node test-api.js
 * Requires: backend running on localhost:3000
 */
const BASE = process.env.API_BASE || 'http://localhost:3000';

async function request(method, url, opts = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token && { Authorization: `Bearer ${opts.token}` }),
      ...opts.headers,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

function ok(name, r, expectStatus = 200) {
  const pass = r.status >= 200 && r.status < 300 && (expectStatus ? r.status === expectStatus : true);
  console.log(pass ? '✓' : '✗', name, '-', r.status, pass ? '' : JSON.stringify(r.data)?.slice(0, 80));
  return pass;
}

async function main() {
  console.log('\n=== SimpleReserva API Tests ===\n');
  let passed = 0;
  let failed = 0;

  // 1. Health
  try {
    const r = await request('GET', '/');
    if (ok('GET / (health)', r)) passed++; else failed++;
  } catch (e) {
    console.log('✗ GET / -', e.message);
    failed++;
  }

  // 2. Public restaurant by slug
  try {
    const r = await request('GET', '/api/public/restaurants/la-casona-de-pedro');
    if (ok('GET /api/public/restaurants/:slug', r)) passed++; else failed++;
  } catch (e) {
    console.log('✗ GET public restaurant -', e.message);
    failed++;
  }

  // 3. Public availability
  try {
    const d = new Date();
    d.setDate(d.getDate() + 3);
    const date = d.toISOString().split('T')[0];
    const r = await request('GET', `/api/public/restaurants/la-casona-de-pedro/availability?date=${date}&partySize=2`);
    if (ok('GET /api/public/restaurants/:slug/availability', r)) passed++; else failed++;
  } catch (e) {
    console.log('✗ GET availability -', e.message);
    failed++;
  }

  // 4. Login restaurant owner
  let restToken;
  let restId = null;
  try {
    const r = await request('POST', '/api/auth/login', {
      body: { email: 'carlos@lacasona.cl', password: 'owner123' },
    });
    if (r.status === 200 && r.data?.token) {
      restToken = r.data.token;
      restId = r.data.restaurants?.[0]?.id ?? null;
      console.log('✓ POST /api/auth/login (restaurant)');
      passed++;
    } else if (r.data?.requiresTwoFactor || r.data?.requiresTwoFactorSetup) {
      console.log('⚠ Login requires 2FA - skipping restaurant tests');
    } else {
      console.log('✗ POST /api/auth/login -', r.status, r.data?.error || r.data);
      failed++;
    }
  } catch (e) {
    console.log('✗ Login -', e.message);
    failed++;
  }

  // 5. Login admin
  let adminToken;
  try {
    const r = await request('POST', '/api/auth/login', {
      body: { email: 'admin@simplereserva.com', password: 'admin123' },
    });
    if (r.status === 200 && r.data?.token) {
      adminToken = r.data.token;
      console.log('✓ POST /api/auth/login (admin)');
      passed++;
    } else {
      console.log('✗ POST /api/auth/login admin -', r.status, r.data);
      failed++;
    }
  } catch (e) {
    console.log('✗ Admin login -', e.message);
    failed++;
  }

  // Fallback: get restaurantId from profile if not in login response
  if (restToken && !restId) {
    const prof = await request('GET', '/api/auth/profile', { token: restToken });
    restId = prof.data?.restaurants?.[0]?.id ?? prof.data?.restaurants?.[0] ?? null;
  }

  if (restToken && restId) {
    const base = `/api/restaurant/${restId}`;

    // 6. GET restaurant
    try {
      const r = await request('GET', base, { token: restToken });
      if (ok('GET /api/restaurant/:id', r)) passed++; else failed++;
    } catch (e) {
      console.log('✗ GET restaurant -', e.message);
      failed++;
    }

    // 7. GET zones
    try {
      const r = await request('GET', `${base}/zones`, { token: restToken });
      if (ok('GET /api/restaurant/:id/zones', r)) passed++; else failed++;
    } catch (e) {
      console.log('✗ GET zones -', e.message);
      failed++;
    }

    // 8. GET tables (need zoneId from zones)
    try {
      const zr = await request('GET', `${base}/zones`, { token: restToken });
      const zones = Array.isArray(zr.data) ? zr.data : zr.data?.zones || [];
      const zoneId = zones[0]?.id;
      if (zoneId) {
        const r = await request('GET', `${base}/tables/zone/${zoneId}`, { token: restToken });
        if (ok('GET /api/restaurant/:id/tables/zone/:zoneId', r)) passed++; else failed++;
      } else {
        console.log('⚠ GET tables - no zones, skip');
      }
    } catch (e) {
      console.log('✗ GET tables -', e.message);
      failed++;
    }

    // 9. GET schedules
    try {
      const r = await request('GET', `${base}/schedules`, { token: restToken });
      if (ok('GET /api/restaurant/:id/schedules', r)) passed++; else failed++;
    } catch (e) {
      console.log('✗ GET schedules -', e.message);
      failed++;
    }

    // 10. GET reservations
    try {
      const r = await request('GET', `${base}/reservations`, { token: restToken });
      if (ok('GET /api/restaurant/:id/reservations', r)) passed++; else failed++;
    } catch (e) {
      console.log('✗ GET reservations -', e.message);
      failed++;
    }

    // 11. GET table-status
    try {
      const r = await request('GET', `${base}/tables/status`, { token: restToken });
      if (ok('GET /api/restaurant/:id/tables/status', r)) passed++; else failed++;
    } catch (e) {
      console.log('✗ GET table-status -', e.message);
      failed++;
    }

    // 12. GET blocked-slots
    try {
      const r = await request('GET', `${base}/blocked-slots`, { token: restToken });
      if (ok('GET /api/restaurant/:id/blocked-slots', r)) passed++; else failed++;
    } catch (e) {
      console.log('✗ GET blocked-slots -', e.message);
      failed++;
    }

    // 13. GET analytics
    try {
      const r = await request('GET', `${base}/analytics`, { token: restToken });
      if (ok('GET /api/restaurant/:id/analytics', r)) passed++; else failed++;
    } catch (e) {
      console.log('✗ GET analytics -', e.message);
      failed++;
    }

    // 15. GET subscription
    try {
      const r = await request('GET', `${base}/subscription`, { token: restToken });
      if (ok('GET /api/restaurant/:id/subscription', r)) passed++; else failed++;
    } catch (e) {
      console.log('✗ GET subscription -', e.message);
      failed++;
    }

    // 16. GET team
    try {
      const r = await request('GET', `${base}/team`, { token: restToken });
      if (ok('GET /api/restaurant/:id/team', r)) passed++; else failed++;
    } catch (e) {
      console.log('✗ GET team -', e.message);
      failed++;
    }
  } else {
    console.log('⚠ Skipping restaurant endpoints - no token or restaurantId');
  }

  // Admin endpoints
  if (adminToken) {
    try {
      const r = await request('GET', '/api/admin/restaurants', { token: adminToken });
      if (ok('GET /api/admin/restaurants', r)) passed++; else failed++;
    } catch (e) {
      console.log('✗ GET admin restaurants -', e.message);
      failed++;
    }
    try {
      const r = await request('GET', '/api/admin/users', { token: adminToken });
      if (ok('GET /api/admin/users', r)) passed++; else failed++;
    } catch (e) {
      console.log('✗ GET admin users -', e.message);
      failed++;
    }
    try {
      const r = await request('GET', '/api/admin/subscriptions', { token: adminToken });
      if (ok('GET /api/admin/subscriptions', r)) passed++; else failed++;
    } catch (e) {
      console.log('✗ GET admin subscriptions -', e.message);
      failed++;
    }
    try {
      const r = await request('GET', '/api/admin/analytics', { token: adminToken });
      if (ok('GET /api/admin/analytics', r)) passed++; else failed++;
    } catch (e) {
      console.log('✗ GET admin analytics -', e.message);
      failed++;
    }
  }

  // Create reservation (public)
  try {
    const d = new Date();
    d.setDate(d.getDate() + 5);
    const date = d.toISOString().split('T')[0];
    const avail = await request('GET', `/api/public/restaurants/la-casona-de-pedro/availability?date=${date}&partySize=2`);
    const slots = avail.data?.slots || [];
    const time = slots[0]?.time || '19:00';
    const r = await request('POST', '/api/reservations', {
      body: {
        restaurantSlug: 'la-casona-de-pedro',
        date,
        time,
        partySize: 2,
        customerName: 'Test User',
        customerPhone: '+56912345678',
        customerEmail: 'test@example.com',
      },
    });
    if (ok('POST /api/reservations (public booking)', r, 201)) passed++; else failed++;
  } catch (e) {
    console.log('✗ POST reservation -', e.message);
    failed++;
  }

  console.log('\n--- Summary ---');
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
