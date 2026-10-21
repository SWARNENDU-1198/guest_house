import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { api, V, freshWorld, makeUser, db, app } from './helpers.js';
import { buildHouse } from './fixtures.js';
import { createApp } from '../src/app.js';
import { todayIST, addDays } from '../src/lib/dates.js';
import { redact } from '../src/lib/log.js';
import { mockGateway } from '../src/lib/razorpay.js';
import { reconcilePayments } from '../src/jobs/reconcilePayments.js';
import { buildQr, useTestCert } from './qr.js';

const D = (n) => addDays(todayIST(), n);

describe('v0.9 audit viewer and hardening', () => {
  let admin;
  let acc;
  let guest;
  before(async () => {
    useTestCert();
    await freshWorld();
    admin = await makeUser({ role: 'admin' });
    acc = await makeUser({ role: 'accounts' });
    guest = await makeUser();
    await buildHouse(admin, { roomsPerType: 3 });
  });

  describe('rate limits', () => {
    const limited = createApp({ rateLimits: true });
    it('Aadhaar verify: 5/min per user, the 6th gets 429 RATE_LIMITED', async () => {
      const u = await makeUser({ verified: false, name: 'Rate Tester' });
      const codes = [];
      for (let i = 0; i < 6; i++) codes.push((await request(limited).post(`${V}/me/aadhaar/verify-qr`).set(u.auth).send({ qrData: 'not-a-qr', consent: true })).status);
      assert.deepEqual(codes.slice(0, 5), [422, 422, 422, 422, 422]);
      assert.equal(codes[5], 429);
      const r = await request(limited).post(`${V}/me/aadhaar/verify-qr`).set(u.auth).send({ qrData: 'x', consent: true });
      assert.equal(r.body.error.code, 'RATE_LIMITED');
      assert.ok(r.headers['ratelimit'] || r.headers['ratelimit-policy'], 'standard RateLimit headers');
    });
    it('booking create: 10/min per user', async () => {
      const u = await makeUser();
      const codes = [];
      for (let i = 0; i < 11; i++) codes.push((await request(limited).post(`${V}/bookings`).set(u.auth).send({ roomId: 'nope', checkIn: D(1), checkOut: D(2) })).status);
      assert.ok(codes.slice(0, 10).every((c) => c !== 429));
      assert.equal(codes[10], 429);
    });
    it('general: 30/min per user, counted per user not globally', async () => {
      const u = await makeUser();
      const other = await makeUser();
      const codes = [];
      for (let i = 0; i < 31; i++) codes.push((await request(limited).get(`${V}/me`).set(u.auth)).status);
      assert.equal(codes.filter((c) => c === 200).length, 30);
      assert.equal(codes[30], 429);
      assert.equal((await request(limited).get(`${V}/me`).set(other.auth)).status, 200, 'another user is unaffected');
    });
  });

  describe('validation on every route', () => {
    it('every authenticated route runs a zod validator (route-table check)', () => {
      const exempt = new Set(['GET /health', 'POST /webhooks/razorpay', 'POST /internal/jobs/:name']);
      const v1 = app._router.stack.find((l) => l.name === 'router' && l.regexp.test('/api/v1/health'));
      const missing = [];
      let count = 0;
      const walk = (stack) => {
        for (const layer of stack) {
          if (layer.route) {
            for (const m of Object.keys(layer.route.methods)) {
              const key = `${m.toUpperCase()} ${layer.route.path}`;
              if (Array.isArray(layer.route.path)) continue; // limiter shims
              count += 1;
              if (exempt.has(key)) continue;
              if (!layer.route.stack.some((s) => s.handle.isValidator)) missing.push(key);
            }
          } else if (layer.handle?.stack) walk(layer.handle.stack);
        }
      };
      walk(v1.handle.stack);
      assert.ok(count >= 80, `found ${count} routes`);
      assert.deepEqual(missing, []);
    });

    it('unknown body fields and unknown query params are rejected', async () => {
      let r = await api().get(`${V}/me?admin=true`).set(guest.auth);
      assert.equal(r.status, 400);
      r = await api().get(`${V}/bookings/me?userId=someoneelse`).set(guest.auth);
      assert.equal(r.status, 400);
      r = await api().post(`${V}/queue/abc/accept`).set(guest.auth).send({ force: true });
      assert.equal(r.status, 400);
      r = await api().post(`${V}/bookings`).set(guest.auth).send({ roomId: 'r101', checkIn: D(1), checkOut: D(2), state: 'confirmed' });
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, 'VALIDATION');
      assert.ok(r.body.error.details.issues.length > 0);
    });

    it('malformed JSON -> 400 in the standard error format', async () => {
      const r = await api().post(`${V}/bookings`).set(guest.auth).set('Content-Type', 'application/json').send('{"roomId": ');
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, 'VALIDATION');
    });

    it('oversized bodies are refused', async () => {
      const r = await api().post(`${V}/me/aadhaar/verify-qr`).set(guest.auth).send({ qrData: '1'.repeat(300_000), consent: true });
      assert.equal(r.status, 400);
    });
  });

  describe('audit viewer', () => {
    let bookingId;
    before(async () => {
      const b = (await api().post(`${V}/bookings`).set(guest.auth).send({ roomId: 'r101', checkIn: D(3), checkOut: D(4) })).body.booking;
      bookingId = b.id;
      await api().post(`${V}/bookings/${b.id}/cancel`).set(guest.auth).send({ reason: 'audit trail test' });
      await api().put(`${V}/rates/guest/std`).set(admin.auth).send({ amountPaise: 260000 });
      const fd = await makeUser({ role: 'frontdesk' });
      const b2 = (await api().post(`${V}/bookings`).set(guest.auth).send({ roomId: 'r102', checkIn: D(3), checkOut: D(4) })).body.booking;
      await api().post(`${V}/payments/cash`).set(fd.auth).send({ bookingId: b2.id, amountPaise: b2.amountPaise });
    });

    it('full history of one booking, oldest first', async () => {
      const r = await api().get(`${V}/admin/audit/booking/${bookingId}`).set(admin.auth);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.items.map((a) => a.action), ['booking.create', 'booking.cancel']);
      assert.equal(r.body.items[1].reason, 'audit trail test');
      assert.equal(r.body.items[1].actorUid, guest.uid);
    });

    it('filters by entity, action, actor and date; paginates', async () => {
      let r = await api().get(`${V}/admin/audit?entity=rate`).set(admin.auth);
      assert.ok(r.body.items.length >= 1 && r.body.items.every((a) => a.entity === 'rate'));
      r = await api().get(`${V}/admin/audit?action=booking.cancel`).set(admin.auth);
      assert.ok(r.body.items.every((a) => a.action === 'booking.cancel'));
      r = await api().get(`${V}/admin/audit?actorUid=${guest.uid}&action=booking.create`).set(admin.auth);
      assert.ok(r.body.items.length >= 2 && r.body.items.every((a) => a.actorUid === guest.uid && a.action === 'booking.create'));
      r = await api().get(`${V}/admin/audit?from=${todayIST()}&to=${todayIST()}&limit=3`).set(admin.auth);
      assert.equal(r.body.items.length, 3);
      assert.ok(r.body.nextCursor);
      const p2 = await api().get(`${V}/admin/audit?from=${todayIST()}&to=${todayIST()}&limit=3&cursor=${r.body.nextCursor}`).set(admin.auth);
      assert.equal(p2.body.items.length, 3);
      assert.ok(!p2.body.items.some((a) => r.body.items.find((b) => b.id === a.id)), 'no overlap between pages');
      r = await api().get(`${V}/admin/audit?from=2001-01-01&to=2001-01-02`).set(admin.auth);
      assert.equal(r.body.items.length, 0);
    });

    it('accounts sees payment entries only; guests and front desk see nothing', async () => {
      let r = await api().get(`${V}/admin/audit`).set(acc.auth);
      assert.equal(r.status, 200);
      assert.ok(r.body.items.length > 0 && r.body.items.every((a) => a.entity === 'payment'));
      r = await api().get(`${V}/admin/audit?entity=booking`).set(acc.auth);
      assert.equal(r.status, 403);
      assert.equal((await api().get(`${V}/admin/audit`).set(guest.auth)).status, 403);
      assert.equal((await api().get(`${V}/admin/audit/booking/${bookingId}`).set(acc.auth)).status, 403);
    });

    it('CSV export', async () => {
      const r = await api().get(`${V}/admin/audit.csv?from=${todayIST()}&to=${todayIST()}`).set(admin.auth);
      assert.equal(r.status, 200);
      assert.match(r.headers['content-type'], /text\/csv/);
      assert.ok(r.text.includes('booking.cancel'));
    });

    it('no update or delete endpoint exists for audit entries', async () => {
      const any = (await db.collection('auditLogs').limit(1).get()).docs[0].id;
      for (const m of ['patch', 'put', 'delete']) {
        assert.equal((await api()[m](`${V}/admin/audit/${any}`).set(admin.auth).send({})).status, 404);
        assert.equal((await api()[m](`${V}/admin/audit/booking/${bookingId}`).set(admin.auth).send({})).status, 404);
      }
    });

    it('audit before/after never contain secrets or Aadhaar data', async () => {
      const u = await makeUser({ verified: false, name: 'Audit Aadhaar' });
      await api().post(`${V}/me/aadhaar/verify-qr`).set(u.auth).send({ qrData: buildQr({ name: 'Audit Aadhaar', last4: '8642' }), consent: true });
      const all = (await db.collection('auditLogs').get()).docs.map((d) => JSON.stringify({ before: d.data().before, after: d.data().after }));
      const blob = all.join('\n');
      for (const bad of ['refHash', 'qrData', 'razorpay_signature', '"aadhaar"', '"last4"', 'verifiedName', 'password', 'key_secret']) {
        assert.ok(!blob.includes(bad), `audit contains ${bad}`);
      }
    });
  });

  describe('logs and secrets', () => {
    it('log redaction masks tokens, QR payloads, phones and emails', () => {
      const out = JSON.stringify(redact({ authorization: 'Bearer abc.def', qrData: '1234567890123456789', phone: '+919876543210', email: 'someone@example.com', note: 'call 9876543210', nested: { token: 'x', signature: 'y' } }));
      assert.ok(!out.includes('abc.def'));
      assert.ok(!out.includes('1234567890123456789'));
      assert.ok(!out.includes('9876543210'));
      assert.ok(!out.includes('someone@'));
      assert.ok(out.includes('so***@example.com'));
      assert.ok(out.includes('"token":"[redacted]"'));
    });

    it('no secrets are committed: .env / .secret.local are git-ignored and source has no keys', () => {
      const root = fileURLToPath(new URL('../../', import.meta.url));
      const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
      assert.match(ignore, /^\.env$/m);
      assert.match(ignore, /^\.secret\.local$/m);
      const files = [];
      const walk = (d) => {
        for (const f of readdirSync(d)) {
          if (['node_modules', '.git', 'emulator-data'].includes(f) || f.startsWith('.secret.local') || f === '.env') continue;
          const p = join(d, f);
          if (statSync(p).isDirectory()) walk(p);
          else if (/\.(js|json|md|rules|example|http)$/.test(f)) files.push(p);
        }
      };
      walk(root);
      for (const f of files) {
        const s = readFileSync(f, 'utf8');
        assert.ok(!/rzp_live_[A-Za-z0-9]{8,}/.test(s), `${f} contains a live Razorpay key`);
        assert.ok(!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(s), `${f} contains a private key`);
      }
    });

    it('the frontend only ever receives the public keyId', async () => {
      const b = (await api().post(`${V}/bookings`).set(guest.auth).send({ roomId: 'r103', checkIn: D(6), checkOut: D(7) })).body.booking;
      const r = await api().post(`${V}/payments/order`).set(guest.auth).send({ bookingId: b.id });
      assert.deepEqual(Object.keys(r.body).sort(), ['amount', 'currency', 'keyId', 'orderId', 'paymentId']);
    });
  });

  describe('cron endpoint', () => {
    it('refuses without the shared secret, runs with it', async () => {
      process.env.CRON_SECRET = 'a-very-long-cron-secret-123';
      assert.equal((await api().post(`${V}/internal/jobs/processQueue`).send({})).status, 403);
      assert.equal((await api().post(`${V}/internal/jobs/processQueue`).set('X-Cron-Secret', 'wrong-secret-wrong-secret').send({})).status, 403);
      const r = await api().post(`${V}/internal/jobs/processQueue`).set('X-Cron-Secret', 'a-very-long-cron-secret-123').send({});
      assert.equal(r.status, 200);
      assert.ok('expiredHolds' in r.body.result);
      delete process.env.CRON_SECRET;
      assert.equal((await api().post(`${V}/internal/jobs/processQueue`).set('X-Cron-Secret', 'a-very-long-cron-secret-123').send({})).status, 403, 'disabled when unset');
    });
  });

  describe('payment reconciliation', () => {
    it('a payment captured at Razorpay with no verify and no webhook gets confirmed by the job', async () => {
      const u = await makeUser();
      const b = (await api().post(`${V}/bookings`).set(u.auth).send({ roomId: 'r101', checkIn: D(10), checkOut: D(11) })).body.booking;
      const o = (await api().post(`${V}/payments/order`).set(u.auth).send({ bookingId: b.id })).body;
      mockGateway.pay(o.orderId); // user paid, browser closed, webhook lost
      let r = await reconcilePayments();
      assert.equal((await db.doc(`bookings/${b.id}`).get()).data().state, 'held', 'too fresh: waits for checkout/webhook first');
      r = await reconcilePayments({ now: Date.now() + 5 * 60_000 });
      assert.ok(r.confirmed >= 1);
      assert.equal((await db.doc(`bookings/${b.id}`).get()).data().state, 'confirmed');
      const p = (await db.doc(`payments/${o.paymentId}`).get()).data();
      assert.equal(p.status, 'captured');
      assert.equal(p.source, 'reconcile');
    });

    it('an abandoned order on an expired hold is closed', async () => {
      const u = await makeUser();
      const b = (await api().post(`${V}/bookings`).set(u.auth).send({ roomId: 'r102', checkIn: D(12), checkOut: D(13) })).body.booking;
      const o = (await api().post(`${V}/payments/order`).set(u.auth).send({ bookingId: b.id })).body;
      await db.doc(`bookings/${b.id}`).update({ state: 'expired' });
      await reconcilePayments({ now: Date.now() + 2 * 60 * 60_000 });
      assert.equal((await db.doc(`payments/${o.paymentId}`).get()).data().status, 'abandoned');
    });
  });
});
