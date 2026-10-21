// 50 parallel booking requests for the same room and night -> exactly 1 wins.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, V, freshWorld, makeUser, db } from './helpers.js';
import { buildHouse } from './fixtures.js';
import { todayIST, addDays } from '../src/lib/dates.js';

const N = 50;

describe('race: no double booking', () => {
  let users;
  before(async () => {
    await freshWorld();
    const admin = await makeUser({ role: 'admin' });
    await buildHouse(admin);
    users = [];
    for (let i = 0; i < N; i += 10) users.push(...(await Promise.all(Array.from({ length: 10 }, () => makeUser()))));
  });

  it(`${N} parallel POST /bookings for the same room and night -> 1 x 201, ${N - 1} x 409 ROOM_TAKEN`, async () => {
    const day = addDays(todayIST(), 5);
    const results = await Promise.all(users.map((u) => api().post(`${V}/bookings`).set(u.auth).send({ roomId: 'r101', checkIn: day, checkOut: addDays(day, 1) })));
    const codes = results.map((r) => r.status);
    const won = codes.filter((c) => c === 201).length;
    const taken = results.filter((r) => r.status === 409 && r.body.error.code === 'ROOM_TAKEN').length;
    assert.equal(won, 1, `statuses: ${JSON.stringify(codes)}`);
    assert.equal(taken, N - 1, `statuses: ${JSON.stringify(results.filter((r) => r.status !== 201 && r.status !== 409).map((r) => r.body))}`);
    const bookings = await db.collection('bookings').where('roomId', '==', 'r101').get();
    assert.equal(bookings.size, 1);
    const nights = await db.collection('roomNights').where('roomId', '==', 'r101').get();
    assert.equal(nights.size, 1);
    assert.equal(nights.docs[0].data().bookingId, bookings.docs[0].id);
  });

  it(`${N} parallel overlapping multi-night requests -> still exactly 1 winner`, async () => {
    const start = addDays(todayIST(), 10);
    const results = await Promise.all(
      users.map((u, i) => api().post(`${V}/bookings`).set(u.auth).send({ roomId: 'r102', checkIn: addDays(start, i % 3), checkOut: addDays(start, 3) })),
    );
    assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results.map((r) => r.status)));
    const nights = (await db.collection('roomNights').where('roomId', '==', 'r102').get()).docs.map((d) => d.data().bookingId);
    assert.equal(new Set(nights).size, 1, 'all nights belong to one booking');
  });

  it(`${N} parallel by-type requests for a type with 2 rooms -> exactly 2 winners on different rooms`, async () => {
    const day = addDays(todayIST(), 20);
    const results = await Promise.all(users.map((u) => api().post(`${V}/bookings/by-type`).set(u.auth).send({ roomTypeId: 'dlx', checkIn: day, checkOut: addDays(day, 1) })));
    const winners = results.filter((r) => r.status === 201);
    assert.equal(winners.length, 2, JSON.stringify(results.map((r) => r.status)));
    assert.notEqual(winners[0].body.booking.roomId, winners[1].body.booking.roomId);
    assert.equal(results.filter((r) => r.body?.error?.code === 'ROOM_TAKEN').length, N - 2);
  });
});
