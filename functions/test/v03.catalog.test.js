import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, V, freshWorld, makeUser, db, auditFor } from './helpers.js';

describe('v0.3 rooms, categories, rates, settings', () => {
  let admin;
  let guest;
  const ids = { buildings: [], types: [], rooms: [], cats: [] };

  before(async () => {
    await freshWorld();
    admin = await makeUser({ role: 'admin' });
    guest = await makeUser({ role: 'guest' });
  });

  const post = (u, path, body) => api().post(`${V}${path}`).set(u.auth).send(body);

  it('admin sets up 2 buildings, 3 room types, 10 rooms, 4 categories and a full rate grid via the API', async () => {
    for (const name of ['Main Block', 'Annexe']) {
      const r = await post(admin, '/buildings', { name, address: 'Campus' });
      assert.equal(r.status, 201);
      ids.buildings.push(r.body.item.id);
    }
    for (const [id, name, capacity] of [['std', 'Standard', 2], ['dlx', 'Deluxe', 2], ['ste', 'Suite', 4]]) {
      const r = await post(admin, '/room-types', { id, name, capacity, amenities: ['AC'] });
      assert.equal(r.status, 201);
      ids.types.push(id);
    }
    for (let i = 0; i < 10; i++) {
      const r = await post(admin, '/rooms', { number: String(101 + i), buildingId: ids.buildings[i % 2], roomTypeId: ids.types[i % 3], floor: 1 });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      ids.rooms.push(r.body.item.id);
    }
    for (const [id, isFree] of [['vip', false], ['research', false], ['govt', true], ['alumni', false]]) {
      const r = await post(admin, '/categories', { id, name: id.toUpperCase(), isFree, maxNights: 5, maxAdvanceDays: 30, payLaterAllowed: id === 'research' });
      assert.equal(r.status, 201);
      ids.cats.push(id);
    }
    const cats = (await api().get(`${V}/categories`).set(guest.auth)).body.items;
    assert.equal(cats.length, 9);
    for (const c of cats) {
      for (const t of ids.types) {
        const r = await api().put(`${V}/rates/${c.id}/${t}`).set(admin.auth).send({ amountPaise: 100000 + ids.types.indexOf(t) * 50000 });
        assert.equal(r.status, 200);
      }
    }
    const grid = (await api().get(`${V}/rates`).set(guest.auth)).body.items;
    assert.equal(grid.length, 27);
    assert.ok(grid.every((g) => g.amountPaise !== null));
    assert.ok(grid.filter((g) => g.categoryId === 'official').every((g) => g.amountPaise === 0), 'free categories show 0');
    assert.equal((await api().get(`${V}/rooms`).set(guest.auth)).body.items.length, 10);
    assert.equal((await api().get(`${V}/rooms?roomTypeId=std`).set(guest.auth)).body.items.length, 4);
  });

  it('room numbers are unique per building; references must exist', async () => {
    let r = await post(admin, '/rooms', { number: '101', buildingId: ids.buildings[0], roomTypeId: 'std' });
    assert.equal(r.status, 409);
    r = await post(admin, '/rooms', { number: '999', buildingId: 'nope', roomTypeId: 'std' });
    assert.equal(r.status, 422);
  });

  it('/rates/quote: ₹0 for an official, correct total for a guest', async () => {
    const off = await makeUser({ role: 'official' });
    let r = await api().get(`${V}/rates/quote?roomTypeId=dlx&checkIn=2026-12-01&checkOut=2026-12-04`).set(off.auth);
    assert.equal(r.status, 200);
    assert.equal(r.body.totalPaise, 0);
    assert.equal(r.body.isFree, true);
    r = await api().get(`${V}/rates/quote?roomTypeId=dlx&checkIn=2026-12-01&checkOut=2026-12-04`).set(guest.auth);
    assert.equal(r.body.nights, 3);
    assert.equal(r.body.perNightPaise, 150000);
    assert.equal(r.body.totalPaise, 450000);
  });

  it('quote validates dates', async () => {
    let r = await api().get(`${V}/rates/quote?roomTypeId=dlx&checkIn=2026-12-04&checkOut=2026-12-01`).set(guest.auth);
    assert.equal(r.status, 400);
    r = await api().get(`${V}/rates/quote?roomTypeId=dlx&checkIn=2026-02-30&checkOut=2026-03-02`).set(guest.auth);
    assert.equal(r.status, 400);
  });

  it('rate change writes a history row and an audit entry with before/after', async () => {
    const r = await api().put(`${V}/rates/guest/std`).set(admin.auth).send({ amountPaise: 123400 });
    assert.equal(r.status, 200);
    const hist = await api().get(`${V}/rates/guest/std/history`).set(admin.auth);
    assert.equal(hist.body.items[0].oldAmountPaise, 100000);
    assert.equal(hist.body.items[0].newAmountPaise, 123400);
    const a = (await auditFor('rate', 'guest_std')).find((x) => x.after.amountPaise === 123400);
    assert.deepEqual(a.before, { amountPaise: 100000 });
    assert.equal((await api().get(`${V}/rates/guest/std/history`).set(guest.auth)).status, 403);
  });

  it('non-admin writes are refused with 403 across the catalogue', async () => {
    const fd = await makeUser({ role: 'frontdesk' });
    for (const u of [guest, fd]) {
      const calls = [
        post(u, '/buildings', { name: 'X' }),
        api().patch(`${V}/buildings/${ids.buildings[0]}`).set(u.auth).send({ name: 'Y' }),
        post(u, '/room-types', { name: 'X', capacity: 1 }),
        post(u, '/rooms', { number: '1', buildingId: ids.buildings[0], roomTypeId: 'std' }),
        api().patch(`${V}/rooms/${ids.rooms[0]}`).set(u.auth).send({ floor: 3 }),
        post(u, `/rooms/${ids.rooms[0]}/block`, { from: '2026-12-01', to: '2026-12-02', reason: 'paint' }),
        post(u, '/categories', { name: 'X', isFree: true, maxNights: 1, maxAdvanceDays: 1, payLaterAllowed: false }),
        api().patch(`${V}/categories/guest`).set(u.auth).send({ isFree: true }),
        api().put(`${V}/rates/guest/std`).set(u.auth).send({ amountPaise: 1 }),
        api().patch(`${V}/settings`).set(u.auth).send({ holdMinutes: 99 }),
      ];
      for (const r of await Promise.all(calls)) assert.equal(r.status, 403, `${r.req.method} ${r.req.path}`);
    }
  });

  it('free categories force rate 0 even when the grid says otherwise', async () => {
    const u = await makeUser({ role: 'guest', categoryId: 'govt' });
    const r = await api().get(`${V}/rates/quote?roomTypeId=ste&checkIn=2026-12-01&checkOut=2026-12-03`).set(u.auth);
    assert.equal(r.body.totalPaise, 0);
  });

  it('deactivate instead of delete; inactive items hidden from lists', async () => {
    const r = await api().patch(`${V}/categories/alumni`).set(admin.auth).send({ active: false });
    assert.equal(r.status, 200);
    let list = (await api().get(`${V}/categories`).set(guest.auth)).body.items;
    assert.ok(!list.some((c) => c.id === 'alumni'));
    list = (await api().get(`${V}/categories?includeInactive=true`).set(admin.auth)).body.items;
    assert.ok(list.some((c) => c.id === 'alumni'));
    assert.equal((await api().delete(`${V}/categories/alumni`).set(admin.auth)).status, 404, 'no delete endpoint');
    assert.equal((await api().delete(`${V}/rooms/${ids.rooms[0]}`).set(admin.auth)).status, 404, 'no delete endpoint');
    assert.ok((await auditFor('category', 'alumni')).some((a) => a.action === 'category.deactivate' && a.before.active === true));
  });

  it('settings: anyone reads, admin patches with validation, audited', async () => {
    let r = await api().get(`${V}/settings`).set(guest.auth);
    assert.equal(r.body.settings.holdMinutes, 10);
    r = await api().patch(`${V}/settings`).set(admin.auth).send({ holdMinutes: 15, officialsQueuePriority: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.settings.holdMinutes, 15);
    r = await api().patch(`${V}/settings`).set(admin.auth).send({ holdMinutes: -1 });
    assert.equal(r.status, 400);
    r = await api().patch(`${V}/settings`).set(admin.auth).send({ unknownSetting: 1 });
    assert.equal(r.status, 400);
    const a = await auditFor('settings', 'global');
    assert.equal(a[0].before.holdMinutes, 10);
    assert.equal(a[0].after.holdMinutes, 15);
  });

  it('block / unblock a room creates and frees blocked nights', async () => {
    const room = ids.rooms[1];
    let r = await post(admin, `/rooms/${room}/block`, { from: '2026-12-10', to: '2026-12-13', reason: 'repainting' });
    assert.equal(r.status, 201);
    const blockId = r.body.blockId;
    const nights = await db.collection('roomNights').where('roomId', '==', room).get();
    assert.equal(nights.size, 3);
    assert.ok(nights.docs.every((d) => d.data().state === 'blocked'));
    r = await post(admin, `/rooms/${room}/block`, { from: '2026-12-12', to: '2026-12-14', reason: 'overlap' });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body.error.details.dates, ['2026-12-12']);
    r = await api().delete(`${V}/rooms/${room}/block/${blockId}`).set(admin.auth);
    assert.equal(r.status, 200);
    assert.equal((await db.collection('roomNights').where('roomId', '==', room).get()).size, 0);
    r = await api().delete(`${V}/rooms/${room}/block/${blockId}`).set(admin.auth);
    assert.equal(r.status, 404);
  });

  it('every catalogue write is audited', async () => {
    const actions = new Set((await db.collection('auditLogs').get()).docs.map((d) => d.data().action));
    for (const a of ['building.create', 'roomType.create', 'room.create', 'category.create', 'rate.update', 'settings.update', 'room.block', 'room.unblock']) {
      assert.ok(actions.has(a), a);
    }
  });
});
