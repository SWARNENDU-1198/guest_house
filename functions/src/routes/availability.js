import { Router } from 'express';
import { z } from 'zod';
import { db } from '../firebase.js';
import { ah } from '../middleware/errors.js';
import { validate, zId, zDate } from '../middleware/validate.js';
import { nightsBetween, diffDays } from '../lib/dates.js';
import { priceStay, loadCategory } from '../lib/pricing.js';
import { getSettings } from '../lib/settings.js';

export const router = Router();

async function activeRooms({ roomTypeId, buildingId } = {}) {
  let q = db.collection('rooms').where('active', '==', true);
  if (roomTypeId) q = q.where('roomTypeId', '==', roomTypeId);
  if (buildingId) q = q.where('buildingId', '==', buildingId);
  const snap = await q.get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => a.number.localeCompare(b.number, 'en', { numeric: true }));
}

const nightsInRange = (from, toExclusive) =>
  db.collection('roomNights').where('date', '>=', from).where('date', '<', toExclusive).get();

// GET /availability?checkIn&checkOut&roomTypeId&buildingId — rooms free for every night + price for caller.
router.get(
  '/availability',
  validate({
    query: z
      .strictObject({ checkIn: zDate, checkOut: zDate, roomTypeId: zId.optional(), buildingId: zId.optional() })
      .refine((q) => q.checkOut > q.checkIn && diffDays(q.checkIn, q.checkOut) <= 90, { message: 'checkOut must be after checkIn (max 90 nights)', path: ['checkOut'] }),
  }),
  ah(async (req, res) => {
    const { checkIn, checkOut, roomTypeId, buildingId } = req.q;
    const [rooms, nights, userSnap, types, settings] = await Promise.all([
      activeRooms({ roomTypeId, buildingId }),
      nightsInRange(checkIn, checkOut),
      db.collection('users').doc(req.user.uid).get(),
      db.collection('roomTypes').get(),
      getSettings(),
    ]);
    const taken = new Set(nights.docs.map((d) => d.data().roomId));
    const free = rooms.filter((r) => !taken.has(r.id) && r.status !== 'blocked');
    const category = await loadCategory(null, userSnap.data()?.categoryId);
    const n = nightsBetween(checkIn, checkOut).length;
    const typeIds = [...new Set(free.map((r) => r.roomTypeId))];
    const rates = typeIds.length ? await db.getAll(...typeIds.map((t) => db.collection('rates').doc(`${category.id}_${t}`))) : [];
    const typeName = new Map(types.docs.map((d) => [d.id, d.data()]));
    const byType = typeIds.map((t, i) => {
      let price = null;
      try {
        price = priceStay({ category, rate: rates[i].exists ? rates[i].data() : null, nights: n, taxPercent: settings.taxPercent });
      } catch {
        /* no rate set for this category/type */
      }
      return {
        roomTypeId: t,
        name: typeName.get(t)?.name ?? t,
        capacity: typeName.get(t)?.capacity ?? null,
        amenities: typeName.get(t)?.amenities ?? [],
        freeCount: free.filter((r) => r.roomTypeId === t).length,
        perNightPaise: price?.perNightPaise ?? null,
        totalPaise: price?.totalPaise ?? null,
        isFree: price?.isFree ?? false,
      };
    });
    res.json({
      checkIn,
      checkOut,
      nights: n,
      categoryId: category.id,
      rooms: free.map((r) => ({ id: r.id, number: r.number, buildingId: r.buildingId, roomTypeId: r.roomTypeId, floor: r.floor })),
      byType,
    });
  }),
);

// GET /availability/board?from&to — room x date grid for the calendar (to exclusive).
// For live updates the frontend listens to roomNights with onSnapshot instead.
router.get(
  '/availability/board',
  validate({
    query: z
      .strictObject({ from: zDate, to: zDate, roomTypeId: zId.optional(), buildingId: zId.optional() })
      .refine((q) => q.to > q.from && diffDays(q.from, q.to) <= 62, { message: '"to" must be after "from" (max 62 days)', path: ['to'] }),
  }),
  ah(async (req, res) => {
    const { from, to, roomTypeId, buildingId } = req.q;
    const [rooms, nights] = await Promise.all([activeRooms({ roomTypeId, buildingId }), nightsInRange(from, to)]);
    const grid = new Map(rooms.map((r) => [r.id, {}]));
    for (const d of nights.docs) {
      const n = d.data();
      if (grid.has(n.roomId)) grid.get(n.roomId)[n.date] = n.state;
    }
    res.json({
      from,
      to,
      dates: nightsBetween(from, to),
      rooms: rooms.map((r) => ({ id: r.id, number: r.number, roomTypeId: r.roomTypeId, buildingId: r.buildingId, status: r.status, nights: grid.get(r.id) })),
    });
  }),
);
