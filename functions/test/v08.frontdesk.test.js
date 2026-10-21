import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, V, freshWorld, makeUser, db } from './helpers.js';
import { buildHouse } from './fixtures.js';
import { todayIST, addDays } from '../src/lib/dates.js';
import { mockGateway } from '../src/lib/razorpay.js';

const T = todayIST();
const D = (n) => addDays(T, n);

describe('v0.8 front desk, dashboards, reports', () => {
  let admin;
  let fd;
  let acc;
  let guest;
  let stay;
  before(async () => {
    await freshWorld();
    admin = await makeUser({ role: 'admin' });
    fd = await makeUser({ role: 'frontdesk' });
    acc = await makeUser({ role: 'accounts' });
    guest = await makeUser({ name: 'Ravi Guest' });
    await buildHouse(admin, { roomsPerType: 2 });
    await api().patch(`${V}/settings`).set(admin.auth).send({ maxActiveBookings: 10 });
    // A paid stay starting today (3 nights)
    const b = (await api().post(`${V}/bookings`).set(guest.auth).send({ roomId: 'r101', checkIn: T, checkOut: D(3) })).body.booking;
    await api().post(`${V}/payments/cash`).set(fd.auth).send({ bookingId: b.id, amountPaise: b.amountPaise });
    stay = b;
  });

  it('today shows the arrival; lookup by booking code finds it', async () => {
    let r = await api().get(`${V}/frontdesk/today`).set(fd.auth);
    assert.equal(r.status, 200);
    assert.ok(r.body.arrivals.some((b) => b.id === stay.id));
    r = await api().get(`${V}/frontdesk/lookup?code=${stay.code}`).set(fd.auth);
    assert.equal(r.body.booking.id, stay.id);
    assert.equal(r.body.guest.name, 'Ravi Guest');
    r = await api().get(`${V}/frontdesk/lookup?code=${stay.id}`).set(fd.auth);
    assert.equal(r.body.booking.code, stay.code);
    assert.equal((await api().get(`${V}/frontdesk/today`).set(guest.auth)).status, 403);
  });

  it('check-in: confirmed + today -> checked_in, room occupied, nights occupied', async () => {
    const r = await api().post(`${V}/frontdesk/bookings/${stay.id}/check-in`).set(fd.auth).send({});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.booking.state, 'checked_in');
    assert.equal((await db.doc('rooms/r101').get()).data().status, 'occupied');
    assert.equal((await db.doc(`roomNights/r101_${T}`).get()).data().state, 'occupied');
    const again = await api().post(`${V}/frontdesk/bookings/${stay.id}/check-in`).set(fd.auth).send({});
    assert.equal(again.status, 409);
  });

  it('cannot check in a future booking or a held one', async () => {
    const g = await makeUser();
    const f = (await api().post(`${V}/bookings`).set(g.auth).send({ roomId: 'r102', checkIn: D(2), checkOut: D(3) })).body.booking;
    let r = await api().post(`${V}/frontdesk/bookings/${f.id}/check-in`).set(fd.auth).send({});
    assert.equal(r.status, 409, 'held');
    await api().post(`${V}/payments/cash`).set(fd.auth).send({ bookingId: f.id, amountPaise: f.amountPaise });
    r = await api().post(`${V}/frontdesk/bookings/${f.id}/check-in`).set(fd.auth).send({});
    assert.equal(r.status, 422, 'not today');
  });

  it('early check-out with an extra charge -> invoice; room cleaning; remaining nights offered to the queue', async () => {
    const waiter = await makeUser();
    // r102 is free tonight (its booking starts D2), so take it for tonight so the std type is full
    const filler = await makeUser();
    const fb = (await api().post(`${V}/bookings`).set(filler.auth).send({ roomId: 'r102', checkIn: D(1), checkOut: D(2) })).body.booking;
    assert.ok(fb.id);
    const q = (await api().post(`${V}/queue`).set(waiter.auth).send({ roomTypeId: 'std', checkIn: D(1), checkOut: D(2) })).body.entry;
    assert.equal(q.state, 'waiting');
    const r = await api().post(`${V}/frontdesk/bookings/${stay.id}/check-out`).set(fd.auth).send({ lines: [{ label: 'Minibar', amountPaise: 45000 }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.booking.state, 'checked_out');
    assert.equal(r.body.booking.earlyCheckout, true);
    assert.ok(r.body.invoiceId);
    const inv = (await db.doc(`invoices/${r.body.invoiceId}`).get()).data();
    assert.equal(inv.totalPaise, 45000);
    assert.equal(inv.userId, guest.uid);
    assert.equal((await db.doc('rooms/r101').get()).data().status, 'cleaning');
    assert.equal(r.body.offeredToQueue, 1);
    const entry = (await db.doc(`queue/${q.id}`).get()).data();
    assert.equal(entry.state, 'offered');
    assert.equal(entry.offer.roomId, 'r101');
    assert.equal((await db.doc(`roomNights/r101_${D(2)}`).get()).exists, false, 'unused night released');
  });

  it('room ready: cleaning -> available', async () => {
    const r = await api().post(`${V}/frontdesk/rooms/r101/ready`).set(fd.auth).send({});
    assert.equal(r.body.room.status, 'available');
    assert.equal((await api().post(`${V}/frontdesk/rooms/r101/ready`).set(fd.auth).send({})).status, 409);
  });

  it('no-show only after the check-in day ends; releases the nights', async () => {
    const g = await makeUser();
    const b = (await api().post(`${V}/bookings`).set(g.auth).send({ roomId: 'r103', checkIn: T, checkOut: D(2) })).body.booking;
    await api().post(`${V}/payments/cash`).set(fd.auth).send({ bookingId: b.id, amountPaise: b.amountPaise });
    let r = await api().post(`${V}/frontdesk/bookings/${b.id}/no-show`).set(fd.auth).send({});
    assert.equal(r.status, 422, 'check-in day not over');
    // simulate the booking having started yesterday
    await db.doc(`bookings/${b.id}`).update({ checkIn: D(-1) });
    r = await api().post(`${V}/frontdesk/bookings/${b.id}/no-show`).set(fd.auth).send({ reason: 'did not arrive' });
    assert.equal(r.status, 200);
    assert.equal(r.body.booking.state, 'no_show');
    assert.equal((await db.doc(`roomNights/r103_${T}`).get()).exists, false);
  });

  it('each dashboard renders from one call in under 1 second', async () => {
    // online payment so accounts has something
    const g = await makeUser();
    const b = (await api().post(`${V}/bookings`).set(g.auth).send({ roomId: 'r104', checkIn: D(4), checkOut: D(5) })).body.booking;
    const o = (await api().post(`${V}/payments/order`).set(g.auth).send({ bookingId: b.id })).body;
    const { payment, signature } = mockGateway.pay(o.orderId);
    await api().post(`${V}/payments/verify`).set(g.auth).send({ razorpay_order_id: o.orderId, razorpay_payment_id: payment.id, razorpay_signature: signature });
    for (const [u, path, check] of [
      [guest, '/dashboard/me', (x) => x.profile && Array.isArray(x.upcoming) && Array.isArray(x.unpaidInvoices) && x.unpaidInvoices.length === 1],
      [fd, '/dashboard/frontdesk', (x) => x.roomStatusCounts && Array.isArray(x.inHouse)],
      [acc, '/dashboard/accounts', (x) => x.collectedTodayPaise > 0 && x.outstandingPaise === 45000 && x.lastPayments.length > 0],
      [admin, '/dashboard/admin', (x) => typeof x.occupancyTodayPct === 'number' && x.queueLength >= 0 && x.recentAudit.length > 0],
    ]) {
      const t0 = performance.now();
      const r = await api().get(`${V}${path}`).set(u.auth);
      const ms = performance.now() - t0;
      assert.equal(r.status, 200, `${path} ${JSON.stringify(r.body)}`);
      assert.ok(check(r.body), `${path} shape: ${JSON.stringify(r.body).slice(0, 400)}`);
      assert.ok(ms < 1000, `${path} took ${ms.toFixed(0)}ms`);
    }
    assert.equal((await api().get(`${V}/dashboard/admin`).set(acc.auth)).status, 403);
    assert.equal((await api().get(`${V}/dashboard/accounts`).set(guest.auth)).status, 403);
  });

  it('reports: collections by day and by category, occupancy', async () => {
    let r = await api().get(`${V}/reports/collections?from=${D(-1)}&to=${D(1)}&groupBy=day`).set(acc.auth);
    assert.equal(r.status, 200);
    assert.ok(r.body.total.grossPaise > 0);
    assert.ok(r.body.rows.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.key)));
    r = await api().get(`${V}/reports/collections?from=${D(-1)}&to=${D(1)}&groupBy=category`).set(admin.auth);
    assert.ok(r.body.rows.some((x) => x.key === 'guest'));
    r = await api().get(`${V}/reports/occupancy?from=${T}&to=${D(2)}`).set(admin.auth);
    assert.equal(r.body.days.length, 3);
    assert.equal(r.body.roomCount, 6);
    assert.ok(r.body.days.every((d) => d.occupancyPct >= 0 && d.occupancyPct <= 100));
    assert.equal((await api().get(`${V}/reports/occupancy?from=${T}&to=${D(2)}`).set(acc.auth)).status, 403);
  });

  it('payments CSV opens correctly in Excel (BOM, CRLF, quoted, no formula injection)', async () => {
    await db.doc(`users/${guest.uid}`).update({ name: '=HYPERLINK("http://evil")' });
    const r = await api().get(`${V}/reports/payments.csv?from=${D(-1)}&to=${D(1)}`).set(acc.auth).buffer(true).parse((res, cb) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (s += c));
      res.on('end', () => cb(null, s));
    });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/csv/);
    assert.match(r.headers['content-disposition'], /attachment; filename="payments_/);
    const body = r.body;
    assert.equal(body.charCodeAt(0), 0xfeff, 'UTF-8 BOM so Excel detects encoding');
    const lines = body.slice(1).trimEnd().split('\r\n');
    assert.ok(lines.length >= 3);
    assert.ok(lines.every((l) => l.startsWith('"') && l.endsWith('"')));
    assert.equal(lines[0].split('","').length, 13);
    assert.ok(body.includes(`"'=HYPERLINK(""http://evil"")"`), 'formula neutralised and quotes escaped');
    assert.equal((await api().get(`${V}/reports/payments.csv?from=${D(-1)}&to=${D(1)}`).set(fd.auth)).status, 403);
  });
});
