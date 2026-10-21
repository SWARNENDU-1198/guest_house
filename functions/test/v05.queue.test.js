import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, V, freshWorld, makeUser, db, auditFor } from './helpers.js';
import { buildHouse } from './fixtures.js';
import { todayIST, addDays } from '../src/lib/dates.js';
import { processQueue } from '../src/jobs/processQueue.js';
import { outbox } from '../src/lib/mailer.js';
import { Timestamp } from '../src/firebase.js';

const D = (n) => addDays(todayIST(), n);
const join = (u, body) => api().post(`${V}/queue`).set(u.auth).send(body);
const entry = async (id) => (await db.doc(`queue/${id}`).get()).data();
const expireOfferNow = async (queueId) => {
  const e = await entry(queueId);
  const past = Timestamp.fromMillis(Date.now() - 1000);
  await db.doc(`bookings/${e.offer.bookingId}`).update({ holdExpiresAt: past });
  await db.doc(`queue/${queueId}`).update({ 'offer.expiresAt': past });
};

describe('v0.5 first-come queue and offers', () => {
  let admin;
  before(async () => {
    await freshWorld();
    admin = await makeUser({ role: 'admin' });
    await buildHouse(admin, { roomsPerType: 1 }); // std=r101, dlx=r102, ste=r103
  });
  beforeEach(() => outbox.splice(0));

  const S = { roomTypeId: 'std', checkIn: D(5), checkOut: D(7) };
  const ctx = {};

  it('three users queue for a full room type and get server-ordered positions', async () => {
    ctx.holder = await makeUser({ name: 'Holder' });
    const b = await api().post(`${V}/bookings/by-type`).set(ctx.holder.auth).send(S);
    assert.equal(b.status, 201);
    ctx.holderBooking = b.body.booking;
    ctx.users = [];
    ctx.entries = [];
    for (const name of ['Alpha', 'Bravo', 'Charlie']) {
      const u = await makeUser({ name });
      const r = await join(u, S);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.entry.state, 'waiting');
      ctx.users.push(u);
      ctx.entries.push(r.body.entry);
    }
    assert.deepEqual(ctx.entries.map((e) => e.position), [1, 2, 3]);
    assert.ok(ctx.entries[0].seq < ctx.entries[1].seq && ctx.entries[1].seq < ctx.entries[2].seq);
    const me = await api().get(`${V}/queue/me`).set(ctx.users[2].auth);
    assert.equal(me.body.items[0].position, 3);
  });

  it('cannot queue twice for overlapping dates; unverified users cannot queue', async () => {
    let r = await join(ctx.users[0], { roomTypeId: 'dlx', checkIn: D(6), checkOut: D(8) });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'ALREADY_QUEUED');
    r = await join(await makeUser({ verified: false }), S);
    assert.equal(r.body.error.code, 'UNVERIFIED');
  });

  it('cancelling the booking offers the room to the lowest seq only', async () => {
    const r = await api().post(`${V}/bookings/${ctx.holderBooking.id}/cancel`).set(ctx.holder.auth).send({ reason: 'cannot travel' });
    assert.equal(r.status, 200);
    assert.equal(r.body.offeredToQueue, true);
    const [a, b, c] = await Promise.all(ctx.entries.map((e) => entry(e.id)));
    assert.equal(a.state, 'offered');
    assert.equal(b.state, 'waiting');
    assert.equal(c.state, 'waiting');
    const offerBooking = (await db.doc(`bookings/${a.offer.bookingId}`).get()).data();
    assert.equal(offerBooking.state, 'held');
    assert.equal(offerBooking.userId, ctx.users[0].uid);
    assert.equal(offerBooking.offerQueueId, ctx.entries[0].id);
    const mins = (offerBooking.holdExpiresAt.toMillis() - Date.now()) / 60000;
    assert.ok(mins > 29 && mins <= 30.1, 'offer window is 30 minutes');
    assert.ok(outbox.some((m) => m.tag === 'queue.offer' && m.to === ctx.users[0].email), 'offer email sent');
    const me = await api().get(`${V}/queue/me`).set(ctx.users[1].auth);
    assert.equal(me.body.items[0].position, 1, 'Bravo moves up');
  });

  it('the freed room never appears available while an offer is pending', async () => {
    const someone = await makeUser();
    const av = await api().get(`${V}/availability?checkIn=${D(5)}&checkOut=${D(7)}&roomTypeId=std`).set(someone.auth);
    assert.deepEqual(av.body.rooms, []);
    const board = await api().get(`${V}/availability/board?from=${D(5)}&to=${D(7)}&roomTypeId=std`).set(someone.auth);
    assert.deepEqual(board.body.rooms[0].nights, { [D(5)]: 'held', [D(6)]: 'held' });
    const grab = await api().post(`${V}/bookings`).set(someone.auth).send({ roomId: 'r101', checkIn: D(5), checkOut: D(6) });
    assert.equal(grab.body.error.code, 'ROOM_TAKEN');
  });

  it('accepting an expired offer -> OFFER_EXPIRED', async () => {
    await db.doc(`queue/${ctx.entries[0].id}`).update({ 'offer.expiresAt': Timestamp.fromMillis(Date.now() - 1000) });
    const r = await api().post(`${V}/queue/${ctx.entries[0].id}/accept`).set(ctx.users[0].auth).send({});
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'OFFER_EXPIRED');
  });

  it('letting the offer lapse moves it to the next user in one processQueue run (job runs every minute)', async () => {
    await expireOfferNow(ctx.entries[0].id);
    const res = await processQueue();
    assert.ok(res.expiredHolds >= 1);
    const [a, b, c] = await Promise.all(ctx.entries.map((e) => entry(e.id)));
    assert.equal(a.state, 'expired');
    assert.equal(b.state, 'offered');
    assert.equal(c.state, 'waiting');
    assert.equal((await db.doc(`roomNights/r101_${D(5)}`).get()).data().bookingId, b.offer.bookingId);
    assert.ok(outbox.some((m) => m.to === ctx.users[1].email));
  });

  it('declining passes the offer to the next in line', async () => {
    const r = await api().post(`${V}/queue/${ctx.entries[1].id}/decline`).set(ctx.users[1].auth).send({});
    assert.equal(r.status, 200);
    assert.equal(r.body.passedOn, true);
    assert.equal((await entry(ctx.entries[1].id)).state, 'removed');
    assert.equal((await entry(ctx.entries[2].id)).state, 'offered');
  });

  it('accepting a paid offer returns the held booking to pay for', async () => {
    const other = await makeUser();
    assert.equal((await api().post(`${V}/queue/${ctx.entries[2].id}/accept`).set(other.auth).send({})).status, 404, 'not the owner');
    const r = await api().post(`${V}/queue/${ctx.entries[2].id}/accept`).set(ctx.users[2].auth).send({});
    assert.equal(r.status, 200);
    assert.equal(r.body.payNow, true);
    assert.equal(r.body.booking.state, 'held');
    assert.equal(r.body.booking.amountPaise, 2 * 250000);
    assert.equal((await entry(ctx.entries[2].id)).state, 'accepted');
  });

  it('a free (official) offer is confirmed on accept', async () => {
    const holder = await makeUser();
    const b = (await api().post(`${V}/bookings`).set(holder.auth).send({ roomId: 'r102', checkIn: D(9), checkOut: D(10) })).body.booking;
    const off = await makeUser({ role: 'official' });
    const q = (await join(off, { roomTypeId: 'dlx', checkIn: D(9), checkOut: D(10) })).body.entry;
    await api().post(`${V}/bookings/${b.id}/cancel`).set(holder.auth).send({ reason: 'changed plans' });
    const r = await api().post(`${V}/queue/${q.id}/accept`).set(off.auth).send({});
    assert.equal(r.body.booking.state, 'confirmed');
    assert.equal(r.body.booking.amountPaise, 0);
    assert.equal((await db.doc(`roomNights/r102_${D(9)}`).get()).data().state, 'booked');
  });

  it('admin moves a queue entry: reason mandatory, audited, user notified; front desk cannot move', async () => {
    const holder = await makeUser();
    await api().post(`${V}/bookings`).set(holder.auth).send({ roomId: 'r103', checkIn: D(12), checkOut: D(13) });
    const us = [await makeUser(), await makeUser(), await makeUser()];
    const es = [];
    for (const u of us) es.push((await join(u, { roomTypeId: 'ste', checkIn: D(12), checkOut: D(13) })).body.entry);
    let r = await api().post(`${V}/admin/queue/${es[2].id}/move`).set(admin.auth).send({ newPosition: 1 });
    assert.equal(r.status, 400, 'reason required');
    const fd = await makeUser({ role: 'frontdesk' });
    r = await api().post(`${V}/admin/queue/${es[2].id}/move`).set(fd.auth).send({ newPosition: 1, reason: 'medical' });
    assert.equal(r.status, 403);
    r = await api().post(`${V}/admin/queue/${es[2].id}/move`).set(admin.auth).send({ newPosition: 1, reason: 'medical emergency' });
    assert.equal(r.status, 200);
    assert.equal(r.body.entry.position, 1);
    const list = await api().get(`${V}/admin/queue?roomTypeId=ste`).set(fd.auth);
    assert.deepEqual(list.body.items.map((e) => e.id), [es[2].id, es[0].id, es[1].id]);
    const a = (await auditFor('queue', es[2].id)).find((x) => x.action === 'queue.move');
    assert.equal(a.reason, 'medical emergency');
    assert.deepEqual([a.before.position, a.after.position], [3, 1]);
    assert.ok(outbox.some((m) => m.tag === 'queue.move' && m.to === us[2].email));
    const guest = await makeUser();
    assert.equal((await api().get(`${V}/admin/queue`).set(guest.auth)).status, 403);
  });

  it('officials jump the queue only when the setting is on', async () => {
    const hold = await makeUser();
    const hb = (await api().post(`${V}/bookings`).set(hold.auth).send({ roomId: 'r102', checkIn: D(15), checkOut: D(16) })).body.booking;
    const g = await makeUser();
    const gq = (await join(g, { roomTypeId: 'dlx', checkIn: D(15), checkOut: D(16) })).body.entry;
    const off = await makeUser({ role: 'official' });
    const oq = (await join(off, { roomTypeId: 'dlx', checkIn: D(15), checkOut: D(16) })).body.entry;
    assert.equal(oq.position, 2, 'setting off: officials wait their turn');
    await api().patch(`${V}/settings`).set(admin.auth).send({ officialsQueuePriority: true });
    const me = await api().get(`${V}/queue/me`).set(off.auth);
    assert.equal(me.body.items.find((e) => e.id === oq.id).position, 1);
    await api().post(`${V}/bookings/${hb.id}/cancel`).set(hold.auth).send({ reason: 'freeing it' });
    assert.equal((await entry(oq.id)).state, 'offered');
    assert.equal((await entry(gq.id)).state, 'waiting');
    await api().patch(`${V}/settings`).set(admin.auth).send({ officialsQueuePriority: false });
  });

  it('admin unblock offers the freed nights to the queue first', async () => {
    const block = await api().post(`${V}/rooms/r103/block`).set(admin.auth).send({ from: D(20), to: D(22), reason: 'maintenance' });
    const u = await makeUser();
    const q = (await join(u, { roomTypeId: 'ste', checkIn: D(20), checkOut: D(21) })).body.entry;
    assert.equal(q.state, 'waiting');
    const r = await api().delete(`${V}/rooms/r103/block/${block.body.blockId}`).set(admin.auth);
    assert.equal(r.body.offeredToQueue, 1);
    assert.equal((await entry(q.id)).state, 'offered');
    assert.equal((await db.doc(`roomNights/r103_${D(21)}`).get()).exists, false, 'unused freed night is released');
  });

  it('joining when a matching room is free gets an offer straight away; leaving works', async () => {
    const u = await makeUser();
    const r = await join(u, { roomTypeId: 'std', checkIn: D(25), checkOut: D(26) });
    assert.equal(r.body.entry.state, 'offered');
    const del = await api().delete(`${V}/queue/${r.body.entry.id}`).set(u.auth);
    assert.equal(del.status, 200);
    assert.equal((await db.doc(`roomNights/r101_${D(25)}`).get()).exists, false);
  });

  it('safety sweep catches a waiting entry for a room that is free', async () => {
    const u = await makeUser();
    const ref = await db.collection('queue').add({ userId: u.uid, userName: u.name, roomTypeId: 'std', checkIn: D(27), checkOut: D(28), seq: 9999, state: 'waiting', isOfficial: false, offer: null });
    const res = await processQueue();
    assert.ok(res.offers >= 1);
    assert.equal((await entry(ref.id)).state, 'offered');
  });

  it('every queue action is audited', async () => {
    await api().post(`${V}/rooms/r101/block`).set(admin.auth).send({ from: D(40), to: D(41), reason: 'deep clean' });
    const u = await makeUser();
    const q = (await join(u, { roomTypeId: 'std', checkIn: D(40), checkOut: D(41) })).body.entry;
    assert.equal(q.state, 'waiting');
    assert.equal((await api().delete(`${V}/queue/${q.id}`).set(u.auth)).status, 200);
    const actions = new Set((await db.collection('auditLogs').where('entity', '==', 'queue').get()).docs.map((d) => d.data().action));
    for (const a of ['queue.join', 'queue.offer', 'queue.offer.expire', 'queue.decline', 'queue.accept', 'queue.move', 'queue.leave']) assert.ok(actions.has(a), a);
  });
});
