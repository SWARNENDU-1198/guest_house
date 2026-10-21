import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, V, freshWorld, makeUser, db, auditFor, signIn, sleep, FieldValue } from './helpers.js';
import { buildHouse } from './fixtures.js';
import { todayIST, addDays } from '../src/lib/dates.js';
import { expireHolds } from '../src/jobs/expireHolds.js';
import { Timestamp } from '../src/firebase.js';

const D = (n) => addDays(todayIST(), n);
const book = (u, body, headers = {}) => api().post(`${V}/bookings`).set(u.auth).set(headers).send(body);
const nightsOf = async (roomId) => (await db.collection('roomNights').where('roomId', '==', roomId).get()).docs.map((d) => d.data());

describe('v0.4 availability and booking', () => {
  let admin;
  let house;
  before(async () => {
    await freshWorld();
    admin = await makeUser({ role: 'admin' });
    house = await buildHouse(admin);
  });

  it('unverified user -> 403 UNVERIFIED', async () => {
    const u = await makeUser({ verified: false });
    const r = await book(u, { roomId: 'r101', checkIn: D(3), checkOut: D(4) });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'UNVERIFIED');
  });

  it('guest gets a 10-minute hold with a server-priced rate snapshot; nights locked as held', async () => {
    const u = await makeUser();
    const r = await book(u, { roomId: 'r101', checkIn: D(3), checkOut: D(5), amountPaise: 1 });
    assert.equal(r.status, 400, 'client cannot send an amount');
    const ok = await book(u, { roomId: 'r101', checkIn: D(3), checkOut: D(5) });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const b = ok.body.booking;
    assert.equal(b.state, 'held');
    assert.equal(b.amountPaise, 2 * 250000);
    assert.equal(b.rateSnapshot.perNightPaise, 250000);
    assert.match(b.code, /^BK-\d{6}$/);
    const mins = (Date.parse(b.holdExpiresAt) - Date.now()) / 60000;
    assert.ok(mins > 9 && mins <= 10.1, `hold ${mins} min`);
    const nights = await nightsOf('r101');
    assert.deepEqual(nights.map((n) => n.state), ['held', 'held']);
    assert.ok(nights.every((n) => n.bookingId === b.id));
    assert.equal((await auditFor('booking', b.id))[0].action, 'booking.create');
  });

  it('overlapping booking of the same room -> 409 ROOM_TAKEN with a hint to queue', async () => {
    const u = await makeUser();
    const r = await book(u, { roomId: 'r101', checkIn: D(4), checkOut: D(6) });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'ROOM_TAKEN');
    assert.equal(r.body.error.details.canQueue, true);
    assert.deepEqual(r.body.error.details.dates, [D(4)]);
  });

  it('official booking is confirmed immediately with amount 0', async () => {
    const o = await makeUser({ role: 'official' });
    const r = await book(o, { roomId: 'r105', checkIn: D(2), checkOut: D(4) });
    assert.equal(r.status, 201);
    assert.equal(r.body.booking.state, 'confirmed');
    assert.equal(r.body.booking.amountPaise, 0);
    assert.equal(r.body.booking.holdExpiresAt, null);
    assert.deepEqual((await nightsOf('r105')).map((n) => n.state), ['booked', 'booked']);
  });

  it('approving an official changes claims; their next booking is ₹0 (v0.2 done-when)', async () => {
    const g = await makeUser({ role: 'guest' });
    const req = await api().post(`${V}/me/official-request`).set(g.auth).send({ department: 'Chemistry', designation: 'Reader', officialEmail: 'r@univ.edu' });
    await sleep(1100);
    await api().post(`${V}/admin/official-requests/${req.body.request.id}/decide`).set(admin.auth).send({ approve: true });
    const t = await signIn(g.email);
    const r = await api().post(`${V}/bookings`).set('Authorization', `Bearer ${t}`).send({ roomId: 'r106', checkIn: D(10), checkOut: D(11) });
    assert.equal(r.status, 201);
    assert.equal(r.body.booking.amountPaise, 0);
    assert.equal(r.body.booking.state, 'confirmed');
  });

  it('category rules: maxNights, past dates, maxAdvanceDays', async () => {
    const s = await makeUser({ role: 'guest', categoryId: 'student' }); // maxNights 3, maxAdvanceDays 30
    let r = await book(s, { roomId: 'r102', checkIn: D(1), checkOut: D(5) });
    assert.equal(r.body.error.code, 'LIMIT_EXCEEDED');
    r = await book(s, { roomId: 'r102', checkIn: D(-2), checkOut: D(-1) });
    assert.equal(r.body.error.code, 'LIMIT_EXCEEDED');
    r = await book(s, { roomId: 'r102', checkIn: D(31), checkOut: D(32) });
    assert.equal(r.body.error.code, 'LIMIT_EXCEEDED');
    assert.equal(r.status, 422);
  });

  it('max active bookings per user', async () => {
    const u = await makeUser();
    for (let i = 0; i < 3; i++) assert.equal((await book(u, { roomId: 'r104', checkIn: D(20 + i * 2), checkOut: D(21 + i * 2) })).status, 201);
    const r = await book(u, { roomId: 'r104', checkIn: D(40), checkOut: D(41) });
    assert.equal(r.body.error.code, 'LIMIT_EXCEEDED');
  });

  it('availability lists free rooms with the caller\'s price; board shows states', async () => {
    const u = await makeUser();
    let r = await api().get(`${V}/availability?checkIn=${D(3)}&checkOut=${D(4)}&roomTypeId=std`).set(u.auth);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.rooms.map((x) => x.id), ['r102']);
    assert.equal(r.body.byType[0].perNightPaise, 250000);
    r = await api().get(`${V}/availability/board?from=${D(2)}&to=${D(6)}`).set(u.auth);
    const row = r.body.rooms.find((x) => x.id === 'r101');
    assert.deepEqual(row.nights, { [D(3)]: 'held', [D(4)]: 'held' });
    assert.equal(r.body.dates.length, 4);
    assert.ok(!JSON.stringify(r.body).includes('bookingId'), 'board does not expose booking ids');
  });

  it('cancelling frees the nights instantly (board + availability)', async () => {
    const u = await makeUser();
    const b = (await book(u, { roomId: 'r102', checkIn: D(7), checkOut: D(9) })).body.booking;
    assert.equal((await nightsOf('r102')).length, 2);
    const other = await makeUser();
    assert.equal((await api().post(`${V}/bookings/${b.id}/cancel`).set(other.auth).send({ reason: 'not mine' })).status, 404);
    const acc = await makeUser({ role: 'accounts' });
    assert.equal((await api().post(`${V}/bookings/${b.id}/cancel`).set(acc.auth).send({ reason: 'accounts try' })).status, 403);
    const r = await api().post(`${V}/bookings/${b.id}/cancel`).set(u.auth).send({ reason: 'plans changed' });
    assert.equal(r.status, 200);
    assert.equal(r.body.booking.state, 'cancelled');
    assert.equal((await nightsOf('r102')).length, 0);
    const av = await api().get(`${V}/availability?checkIn=${D(7)}&checkOut=${D(9)}&roomTypeId=std`).set(u.auth);
    assert.ok(av.body.rooms.some((x) => x.id === 'r102'));
    assert.equal((await api().post(`${V}/bookings/${b.id}/cancel`).set(u.auth).send({ reason: 'again' })).status, 409);
    assert.ok((await auditFor('booking', b.id)).some((a) => a.action === 'booking.cancel' && a.reason === 'plans changed'));
  });

  it('front desk can cancel any booking', async () => {
    const u = await makeUser();
    const fd = await makeUser({ role: 'frontdesk' });
    const b = (await book(u, { roomId: 'r102', checkIn: D(12), checkOut: D(13) })).body.booking;
    const r = await api().post(`${V}/bookings/${b.id}/cancel`).set(fd.auth).send({ reason: 'guest called' });
    assert.equal(r.status, 200);
  });

  it('by-type picks the first free room and reports ROOM_TAKEN when the type is full', async () => {
    const [a, b, c] = await Promise.all([makeUser(), makeUser(), makeUser()]);
    const body = { roomTypeId: 'dlx', checkIn: D(50), checkOut: D(51) };
    const r1 = await api().post(`${V}/bookings/by-type`).set(a.auth).send(body);
    const r2 = await api().post(`${V}/bookings/by-type`).set(b.auth).send(body);
    assert.equal(r1.body.booking.roomId, 'r103');
    assert.equal(r2.body.booking.roomId, 'r104');
    const r3 = await api().post(`${V}/bookings/by-type`).set(c.auth).send(body);
    assert.equal(r3.status, 409);
    assert.equal(r3.body.error.details.canQueue, true);
  });

  it('user with an overdue invoice -> OVERDUE_INVOICE; admin override lets them book', async () => {
    const u = await makeUser();
    await db.collection('invoices').add({ userId: u.uid, status: 'overdue', totalPaise: 1000, paidPaise: 0 });
    let r = await book(u, { roomId: 'r102', checkIn: D(14), checkOut: D(15) });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'OVERDUE_INVOICE');
    r = await api().post(`${V}/admin/bookings`).set(admin.auth).send({ userId: u.uid, roomId: 'r102', checkIn: D(14), checkOut: D(15), overrides: { overdue: true } });
    assert.equal(r.status, 400, 'reason is mandatory');
    r = await api().post(`${V}/admin/bookings`).set(admin.auth).send({ userId: u.uid, roomId: 'r102', checkIn: D(14), checkOut: D(15), overrides: { overdue: true }, reason: 'paid at the counter, recording later' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.booking.createdBy, admin.uid);
    assert.equal((await auditFor('booking', r.body.booking.id))[0].reason, 'paid at the counter, recording later');
  });

  it('front desk books on behalf but cannot skip verification; guests cannot use the admin route', async () => {
    const fd = await makeUser({ role: 'frontdesk' });
    const unv = await makeUser({ verified: false });
    let r = await api().post(`${V}/admin/bookings`).set(fd.auth).send({ userId: unv.uid, roomTypeId: 'ste', checkIn: D(16), checkOut: D(17), overrides: { verification: true }, reason: 'walk in no QR' });
    assert.equal(r.status, 403);
    const g = await makeUser();
    r = await api().post(`${V}/admin/bookings`).set(g.auth).send({ userId: g.uid, roomTypeId: 'ste', checkIn: D(16), checkOut: D(17), reason: 'self service' });
    assert.equal(r.status, 403);
  });

  it('admin moves a booking to new dates in one transaction', async () => {
    const u = await makeUser();
    const b = (await book(u, { roomId: 'r106', checkIn: D(30), checkOut: D(32) })).body.booking;
    const r = await api().patch(`${V}/admin/bookings/${b.id}`).set(admin.auth).send({ checkIn: D(31), checkOut: D(34), reason: 'guest extended' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.booking.nights, 3);
    assert.equal(r.body.booking.amountPaise, 3 * 700000);
    const dates = (await nightsOf('r106')).filter((n) => n.bookingId === b.id).map((n) => n.date).sort();
    assert.deepEqual(dates, [D(31), D(32), D(33)]);
    const fd = await makeUser({ role: 'frontdesk' });
    assert.equal((await api().patch(`${V}/admin/bookings/${b.id}`).set(fd.auth).send({ checkIn: D(31), reason: 'nope' })).status, 403);
  });

  it('expired holds release their nights', async () => {
    const u = await makeUser();
    const b = (await book(u, { roomId: 'r102', checkIn: D(25), checkOut: D(26) })).body.booking;
    await db.doc(`bookings/${b.id}`).update({ holdExpiresAt: Timestamp.fromMillis(Date.now() - 1000) });
    const r = await expireHolds();
    assert.ok(r.expired >= 1);
    assert.equal((await db.doc(`bookings/${b.id}`).get()).data().state, 'expired');
    assert.equal((await nightsOf('r102')).filter((n) => n.bookingId === b.id).length, 0);
  });

  it('Idempotency-Key: a repeated POST returns the first booking', async () => {
    const u = await makeUser();
    const h = { 'Idempotency-Key': 'test-key-123456' };
    const r1 = await book(u, { roomId: 'r102', checkIn: D(27), checkOut: D(28) }, h);
    const r2 = await book(u, { roomId: 'r102', checkIn: D(27), checkOut: D(28) }, h);
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);
    assert.equal(r2.headers['idempotent-replayed'], 'true');
    assert.equal(r1.body.booking.id, r2.body.booking.id);
    const mine = await db.collection('bookings').where('userId', '==', u.uid).get();
    assert.equal(mine.size, 1);
  });

  it('pay-later category: booking confirmed immediately and an invoice is raised', async () => {
    const f = await makeUser({ role: 'guest', categoryId: 'faculty' });
    const r = await book(f, { roomId: 'r103', checkIn: D(60), checkOut: D(62), payLater: true });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.booking.state, 'confirmed');
    const inv = (await db.doc(`invoices/${r.body.booking.invoiceId}`).get()).data();
    assert.equal(inv.totalPaise, 2 * 250000);
    assert.match(inv.number, /^INV\/\d{2}-\d{2}\/000001$/);
    const g = await makeUser();
    const r2 = await book(g, { roomId: 'r103', checkIn: D(40), checkOut: D(41), payLater: true });
    assert.equal(r2.status, 422, 'guest category cannot pay later');
  });

  it('GET /bookings/me (newest first) and GET /bookings/:id access control', async () => {
    const u = await makeUser();
    await book(u, { roomId: 'r101', checkIn: D(40), checkOut: D(41) });
    const b2 = (await book(u, { roomId: 'r101', checkIn: D(45), checkOut: D(46) })).body.booking;
    const r = await api().get(`${V}/bookings/me`).set(u.auth);
    assert.deepEqual(r.body.items.map((b) => b.checkIn), [D(45), D(40)]);
    const other = await makeUser();
    assert.equal((await api().get(`${V}/bookings/${b2.id}`).set(other.auth)).status, 404);
    const fd = await makeUser({ role: 'frontdesk' });
    assert.equal((await api().get(`${V}/bookings/${b2.id}`).set(fd.auth)).status, 200);
  });
});
