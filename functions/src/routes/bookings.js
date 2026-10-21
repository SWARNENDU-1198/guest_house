import { Router } from 'express';
import { z } from 'zod';
import { db, FieldValue } from '../firebase.js';
import { ah, notFound, forbidden, conflict, unprocessable, CODES } from '../middleware/errors.js';
import { requireRole, isStaff } from '../middleware/requireRole.js';
import { validate, zId, zDate, zReason, zPage } from '../middleware/validate.js';
import { actorFrom, writeAudit } from '../lib/audit.js';
import { docJSON, toJSON, paginate } from '../lib/serialize.js';
import { idempotent } from '../lib/idempotency.js';
import { createBooking, runBookingTx, canSeeBooking, refundDue, readFreeNights } from '../lib/booking.js';
import { nightsBetween, diffDays } from '../lib/dates.js';
import { nightRef } from '../lib/nights.js';
import { prepareRelease } from '../lib/release.js';
import { getSettings } from '../lib/settings.js';
import { notifyOffers } from '../lib/queue.js';

export const router = Router();

const stay = { checkIn: zDate, checkOut: zDate };
const stayOk = (b) => b.checkOut > b.checkIn && diffDays(b.checkIn, b.checkOut) <= 90;
const stayMsg = { message: 'checkOut must be after checkIn (max 90 nights)', path: ['checkOut'] };

const bookingJSON = (b) => toJSON(b);

// POST /bookings — { roomId, checkIn, checkOut, payLater? }
router.post(
  '/bookings',
  idempotent(),
  validate({ body: z.strictObject({ roomId: zId, ...stay, payLater: z.boolean().optional() }).refine(stayOk, stayMsg) }),
  ah(async (req, res) => {
    const booking = await runBookingTx((tx) =>
      createBooking(tx, { actor: actorFrom(req), userId: req.user.uid, createdBy: req.user.uid, ...req.body }),
    );
    res.status(201).json({ booking: bookingJSON(booking) });
  }),
);

// POST /bookings/by-type — { roomTypeId, checkIn, checkOut, buildingId? } picks the first free room.
router.post(
  '/bookings/by-type',
  idempotent(),
  validate({ body: z.strictObject({ roomTypeId: zId, buildingId: zId.optional(), ...stay, payLater: z.boolean().optional() }).refine(stayOk, stayMsg) }),
  ah(async (req, res) => {
    const booking = await runBookingTx((tx) =>
      createBooking(tx, { actor: actorFrom(req), userId: req.user.uid, createdBy: req.user.uid, ...req.body }),
    );
    res.status(201).json({ booking: bookingJSON(booking) });
  }),
);

// GET /bookings/me — newest check-in first
router.get(
  '/bookings/me',
  validate({ query: z.strictObject({ ...zPage }) }),
  ah(async (req, res) => {
    const col = db.collection('bookings');
    res.json(await paginate(col.where('userId', '==', req.user.uid).orderBy('checkIn', 'desc'), col, req.q));
  }),
);

router.get(
  '/bookings/:id',
  validate({ params: z.object({ id: zId }) }),
  ah(async (req, res) => {
    const snap = await db.collection('bookings').doc(req.params.id).get();
    if (!snap.exists || !canSeeBooking(req.user, snap.data())) throw notFound('Booking');
    res.json({ booking: docJSON(snap) });
  }),
);

// POST /bookings/:id/cancel — owner / frontdesk / admin. Frees nights (queue first), marks refund due.
router.post(
  '/bookings/:id/cancel',
  validate({ params: z.object({ id: zId }), body: z.strictObject({ reason: zReason }) }),
  ah(async (req, res) => {
    const ref = db.collection('bookings').doc(req.params.id);
    const result = await runBookingTx(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound('Booking');
      const b = snap.data();
      const mine = b.userId === req.user.uid;
      if (!mine && !['frontdesk', 'admin'].includes(req.user.role)) {
        throw canSeeBooking(req.user, b) ? forbidden('Only the guest, front desk or admin can cancel') : notFound('Booking');
      }
      if (!['held', 'confirmed'].includes(b.state)) throw conflict(CODES.INVALID_STATE, `A ${b.state} booking cannot be cancelled`);
      const settings = await getSettings(tx);
      const dates = nightsBetween(b.checkIn, b.checkOut);
      const nightSnaps = await tx.getAll(...dates.map((d) => nightRef(b.roomId, d)));
      const owned = nightSnaps.filter((s) => s.exists && s.data().bookingId === ref.id).map((s) => s.data().date);
      const refund = refundDue({ booking: b, settings });
      const room = await tx.get(db.collection('rooms').doc(b.roomId));
      const rel = await prepareRelease(tx, { room: { id: b.roomId, ...room.data() }, dates: owned });
      const release = rel.apply(actorFrom(req));
      const changes = {
        state: 'cancelled',
        cancelReason: req.body.reason,
        cancelledBy: req.user.uid,
        cancelledAt: FieldValue.serverTimestamp(),
        refundDuePaise: refund.amountPaise,
        refundPercent: refund.percent,
        holdExpiresAt: null,
      };
      tx.update(ref, changes);
      writeAudit(tx, actorFrom(req), { action: 'booking.cancel', entity: 'booking', entityId: ref.id, before: { state: b.state }, after: { state: 'cancelled', refundDuePaise: refund.amountPaise }, reason: req.body.reason });
      return { refund, offers: release.offers };
    });
    await notifyOffers(result.offers);
    res.json({ booking: docJSON(await ref.get()), refundDuePaise: result.refund.amountPaise, refundPercent: result.refund.percent, offeredToQueue: result.offers.length > 0 });
  }),
);

const overrideFlags = z.strictObject({
  limits: z.boolean().optional(),
  advance: z.boolean().optional(),
  overdue: z.boolean().optional(),
  verification: z.boolean().optional(),
});

// POST /admin/bookings — book on behalf of a user, with override flags + mandatory reason.
router.post(
  '/admin/bookings',
  requireRole('admin', 'frontdesk'),
  idempotent(),
  validate({
    body: z
      .strictObject({ userId: zId, roomId: zId.optional(), roomTypeId: zId.optional(), ...stay, payLater: z.boolean().optional(), overrides: overrideFlags.default({}), reason: zReason })
      .refine(stayOk, stayMsg)
      .refine((b) => b.roomId || b.roomTypeId, { message: 'roomId or roomTypeId is required', path: ['roomId'] }),
  }),
  ah(async (req, res) => {
    const { overrides, reason, ...rest } = req.body;
    if (overrides.verification && req.user.role !== 'admin') throw forbidden('Only an admin can skip verification');
    const clean = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v));
    const booking = await runBookingTx((tx) =>
      createBooking(tx, { actor: actorFrom(req), createdBy: req.user.uid, overrides: clean, reason, ...rest }),
    );
    res.status(201).json({ booking: bookingJSON(booking) });
  }),
);

// PATCH /admin/bookings/:id — change room/dates; re-runs the night locks in one transaction.
router.patch(
  '/admin/bookings/:id',
  requireRole('admin'),
  validate({
    params: z.object({ id: zId }),
    body: z.strictObject({ roomId: zId.optional(), checkIn: zDate.optional(), checkOut: zDate.optional(), reason: zReason }).refine((b) => b.roomId || b.checkIn || b.checkOut, 'Nothing to change'),
  }),
  ah(async (req, res) => {
    const ref = db.collection('bookings').doc(req.params.id);
    const actor = actorFrom(req);
    const result = await runBookingTx(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound('Booking');
      const b = snap.data();
      if (!['held', 'confirmed'].includes(b.state)) throw conflict(CODES.INVALID_STATE, `A ${b.state} booking cannot be changed`);
      const next = { roomId: req.body.roomId ?? b.roomId, checkIn: req.body.checkIn ?? b.checkIn, checkOut: req.body.checkOut ?? b.checkOut };
      if (!stayOk(next)) throw unprocessable(CODES.LIMIT_EXCEEDED, 'checkOut must be after checkIn (max 90 nights)');
      const roomSnap = await tx.get(db.collection('rooms').doc(next.roomId));
      if (!roomSnap.exists || roomSnap.data().active === false) throw unprocessable(CODES.NOT_FOUND, 'Unknown or inactive room');
      if (next.roomId !== b.roomId && roomSnap.data().roomTypeId !== b.roomTypeId) {
        throw unprocessable(CODES.INVALID_STATE, 'New room must be of the same room type (price snapshot is per room type)');
      }
      const oldDates = nightsBetween(b.checkIn, b.checkOut);
      const newDates = nightsBetween(next.checkIn, next.checkOut);
      const target = await readFreeNights(tx, next.roomId, newDates, { allowBookingId: ref.id });
      if (!target.free) throw conflict(CODES.ROOM_TAKEN, 'The new room/dates are taken', { dates: target.snaps.filter((s) => s.exists && s.data().bookingId !== ref.id).map((s) => s.data().date) });
      const oldSnaps = await tx.getAll(...oldDates.map((d) => nightRef(b.roomId, d)));
      const keep = new Set(next.roomId === b.roomId ? newDates : []);
      const toFree = oldSnaps.filter((s) => s.exists && s.data().bookingId === ref.id && !keep.has(s.data().date)).map((s) => s.data().date);
      const oldRoom = next.roomId === b.roomId ? roomSnap : await tx.get(db.collection('rooms').doc(b.roomId));
      const rel = await prepareRelease(tx, { room: { id: b.roomId, ...oldRoom.data() }, dates: toFree, reservedDates: next.roomId === b.roomId ? newDates : [] });
      const release = rel.apply(actor);
      const state = b.state === 'held' ? 'held' : 'booked';
      target.refs.forEach((r, i) => {
        if (!target.snaps[i].exists) {
          const rd = roomSnap.data();
          tx.create(r, { roomId: next.roomId, roomTypeId: rd.roomTypeId, buildingId: rd.buildingId, date: newDates[i], bookingId: ref.id, state });
        }
      });
      const perNight = b.rateSnapshot.perNightPaise;
      const subtotal = perNight * newDates.length;
      const tax = Math.round((subtotal * (b.rateSnapshot.taxPercent ?? 0)) / 100);
      const changes = {
        ...next,
        roomNumber: roomSnap.data().number,
        buildingId: roomSnap.data().buildingId,
        nights: newDates.length,
        amountPaise: b.isFree ? 0 : subtotal + tax,
        rateSnapshot: { ...b.rateSnapshot, nights: newDates.length, subtotalPaise: b.isFree ? 0 : subtotal, taxPaise: b.isFree ? 0 : tax, totalPaise: b.isFree ? 0 : subtotal + tax },
      };
      tx.update(ref, changes);
      writeAudit(tx, actor, {
        action: 'booking.modify',
        entity: 'booking',
        entityId: ref.id,
        before: { roomId: b.roomId, checkIn: b.checkIn, checkOut: b.checkOut, amountPaise: b.amountPaise },
        after: { roomId: next.roomId, checkIn: next.checkIn, checkOut: next.checkOut, amountPaise: changes.amountPaise },
        reason: req.body.reason,
      });
      return { offers: release.offers, balanceDuePaise: Math.max(0, changes.amountPaise - (b.paidPaise ?? 0)) };
    });
    await notifyOffers(result.offers);
    res.json({ booking: docJSON(await ref.get()), balanceDuePaise: result.balanceDuePaise, offeredToQueue: result.offers.length > 0 });
  }),
);

export { isStaff };
