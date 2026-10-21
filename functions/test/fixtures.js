// Builds a small guest house through the API (as an admin).
import { api, V } from './helpers.js';

export async function buildHouse(admin, { roomsPerType = 2 } = {}) {
  const post = (path, body) => api().post(`${V}${path}`).set(admin.auth).send(body);
  const b1 = (await post('/buildings', { name: 'Main Block', address: 'Campus Road' })).body.item;
  const b2 = (await post('/buildings', { name: 'Annexe', address: 'Lake Side' })).body.item;
  const types = {};
  for (const [id, name, capacity] of [['std', 'Standard', 2], ['dlx', 'Deluxe', 2], ['ste', 'Suite', 4]]) {
    types[id] = (await post('/room-types', { id, name, capacity, amenities: ['AC', 'WiFi'] })).body.item;
  }
  const rooms = { std: [], dlx: [], ste: [] };
  let n = 100;
  for (const t of Object.keys(types)) {
    for (let i = 0; i < roomsPerType; i++) {
      n += 1;
      const r = await post('/rooms', { id: `r${n}`, number: String(n), buildingId: i % 2 ? b2.id : b1.id, roomTypeId: t, floor: 1 });
      rooms[t].push(r.body.item);
    }
  }
  const grid = { guest: [250000, 400000, 700000], faculty: [150000, 250000, 450000], student: [80000, 120000, 300000], staff: [120000, 200000, 400000], official: [999, 999, 999] };
  for (const [cat, amounts] of Object.entries(grid)) {
    for (const [i, t] of ['std', 'dlx', 'ste'].entries()) {
      await api().put(`${V}/rates/${cat}/${t}`).set(admin.auth).send({ amountPaise: amounts[i] });
    }
  }
  return { buildings: [b1, b2], types, rooms, grid };
}
