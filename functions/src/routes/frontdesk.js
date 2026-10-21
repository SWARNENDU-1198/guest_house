import { Router } from 'express';
import { z } from 'zod';
import { db, auth, FieldValue } from '../firebase.js';
import { ah, conflict, unprocessable, notFound, CODES } from '../middleware/errors.js';
import { requireRole } from '../middleware/requireRole.js';
import { validate, zId, zReason } from '../middleware/validate.js';
import { docJSON } from '../lib/serialize.js';
import { todayIST, nightsBetween } from '../lib/dates.js';
import { nightRef } from '../lib/nights.js';
import { prepareRelease } from '../lib/release.js';
import { notifyOffers } from '../lib/queue.js';
import { prepareCharges, chargeLines } from './invoices.js';
import { writeAudit, actorFrom } from '../lib/audit.js';
import { syncClaims } from '../lib/claims.js';
import { decodeSecureQr, namesMatch } from '../lib/aadhaarQr.js';
import { checkAadhaarFree, writeAadhaar } from '../lib/verification.js';
import { profileJSON } from './me.js';

export const router = Router();

// POST /frontdesk/walk-in — create a verified guest at the counter.
router.post(
  '/frontdesk/walk-in',
  requireRole('frontdesk'),
  validate({
    body: z.strictObject({
      name: z.string().trim().min(1).max(100),
      phone: z.string().trim().regex(/^\+?\d{10,13}$/),
      email: z.email().max(200),
      qrData: z.string().min(1).max(12000),
      consent: z.literal(true, { error: 'Guest consent is required to verify Aadhaar' }),
    }),
  }),
  ah(async (req, res) => {
    const consentAt = new Date();
    const decoded = decodeSecureQr(req.body.qrData);
    req.body.qrData = undefined;
    const { name, phone } = req.body;
    const email = req.body.email.toLowerCase();
    if (!namesMatch(name, decoded.name)) {
      throw unprocessable(CODES.INVALID_QR, 'The name on the Aadhaar does not match the name entered', { reason: 'NAME_MISMATCH' });
    }
    await checkAadhaarFree(null, null, decoded); // fail fast before creating an Auth user
    try {
      await auth.getUserByEmail(email);
      throw conflict(CODES.INVALID_STATE, 'An account with this email already exists; ask the guest to sign in');
    } catch (e) {
      if (e.code !== 'auth/user-not-found') throw e;
    }

    const authUser = await auth.createUser({ email, displayName: name, emailVerified: false });
    const ref = db.collection('users').doc(authUser.uid);
    const user = { name, email, phone, role: 'guest', categoryId: 'guest', status: 'active', officialStatus: 'none', createdBy: req.user.uid };
    try {
      await db.runTransaction(async (tx) => {
        const refInfo = await checkAadhaarFree(tx, authUser.uid, decoded);
        const actor = actorFrom(req);
        tx.create(ref, { ...user, aadhaar: null, createdAt: FieldValue.serverTimestamp() });
        writeAudit(tx, actor, { action: 'user.walkin.create', entity: 'user', entityId: authUser.uid, after: user });
        const aadhaar = writeAadhaar(tx, { uid: authUser.uid, decoded, refInfo, actor, consentAt, userExists: false });
        tx.update(ref, { aadhaar });
      });
    } catch (e) {
      await auth.deleteUser(authUser.uid).catch(() => {});
      throw e;
    }
    await syncClaims(authUser.uid, user);
    res.status(201).json({ profile: profileJSON(await ref.get()) });
  }),
);

// ---------------------------------------------------------------------------
// v0.8 counter operations
// ---------------------------------------------------------------------------

export async function frontdeskToday() {
  const today = todayIST();
  const [arrivals, departures, inHouse, cleaning, rooms] = await Promise.all([
    db.collection('bookings').where('checkIn', '==', today).get(),
    db.collection('bookings').where('checkOut', '==', today).where('state', '==', 'checked_in').get(),
    db.collection('bookings').where('state', '==', 'checked_in').get(),
    db.collection('rooms').where('status', '==', 'cleaning').get(),
    db.collection('rooms').where('active', '==', true).get(),
  ]);
  const roomStatusCounts = {};
  for (const r of rooms.docs) roomStatusCounts[r.data().status] = (roomStatusCounts[r.data().status] ?? 0) + 1;
  return {
    date: today,
    arrivals: arrivals.docs.filter((d) => ['confirmed', 'checked_in'].includes(d.data().state)).map(docJSON),
    departures: departures.docs.map(docJSON),
    inHouse: inHouse.docs.map(docJSON),
    roomsNeedingCleaning: cleaning.docs.map(docJSON),
    roomStatusCounts,
  };
}

router.get(
  '/frontdesk/today',
  requireRole('frontdesk'),
  validate({ query: z.strictObject({}) }),
  ah(async (req, res) => res.json(await frontdeskToday())),
);

// GET /frontdesk/lookup?code=BK-000123 (or a booking id from the QR on the confirmation)
router.get(
  '/frontdesk/lookup',
  requireRole('frontdesk'),
  validate({ query: z.strictObject({ code: z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/) }) }),
  ah(async (req, res) => {
    const code = req.q.code.toUpperCase().startsWith('BK-') ? req.q.code.toUpperCase() : req.q.code;
    let snap = (await db.collection('bookings').where('code', '==', code).limit(1).get()).docs[0];
    if (!snap) {
      const byId = await db.collection('bookings').doc(req.q.code).get();
      snap = byId.exists ? byId : null;
    }
    if (!snap) throw notFound('Booking');
    const user = await db.collection('users').doc(snap.data().userId).get();
    res.json({ booking: docJSON(snap), guest: user.exists ? profileJSON(user) : null });
  }),
);

const bookingParam = { params: z.object({ id: zId }) };

async function readStayContext(tx, id) {
  const ref = db.collection('bookings').doc(id);
  const snap = await tx.get(ref);
  if (!snap.exists) throw notFound('Booking');
  const b = snap.data();
  const roomRef = db.collection('rooms').doc(b.roomId);
  const room = await tx.get(roomRef);
  const dates = nightsBetween(b.checkIn, b.checkOut);
  const nightSnaps = await tx.getAll(...dates.map((d) => nightRef(b.roomId, d)));
  const owned = nightSnaps.filter((s) => s.exists && s.data().bookingId === id).map((s) => s.data().date);
  return { ref, b, roomRef, room: { id: room.id, ...room.data() }, owned };
}

// POST /frontdesk/bookings/:id/check-in — confirmed + today
router.post(
  '/frontdesk/bookings/:id/check-in',
  requireRole('frontdesk'),
  validate({ ...bookingParam, body: z.strictObject({}) }),
  ah(async (req, res) => {
    const today = todayIST();
    await db.runTransaction(async (tx) => {
      const { ref, b, roomRef, room, owned } = await readStayContext(tx, req.params.id);
      if (b.state !== 'confirmed') throw conflict(CODES.INVALID_STATE, `A ${b.state} booking cannot be checked in`);
      if (today < b.checkIn || today >= b.checkOut) throw unprocessable(CODES.INVALID_STATE, `Check-in is only possible from ${b.checkIn} until the day before ${b.checkOut}`);
      if (room.status === 'occupied') throw conflict(CODES.INVALID_STATE, 'The room is still occupied by the previous guest');
      tx.update(ref, { state: 'checked_in', checkedInAt: FieldValue.serverTimestamp(), checkedInBy: req.user.uid });
      tx.update(roomRef, { status: 'occupied', currentBookingId: ref.id });
      owned.filter((d) => d >= today).forEach((d) => tx.update(nightRef(b.roomId, d), { state: 'occupied' }));
      writeAudit(tx, actorFrom(req), { action: 'booking.checkin', entity: 'booking', entityId: ref.id, before: { state: 'confirmed', roomStatus: room.status }, after: { state: 'checked_in', roomStatus: 'occupied' } });
    });
    res.json({ booking: docJSON(await db.collection('bookings').doc(req.params.id).get()) });
  }),
);

// POST /frontdesk/bookings/:id/check-out — { lines? } optional charges -> invoice; room -> cleaning;
// early check-out releases tonight and later nights to the queue.
router.post(
  '/frontdesk/bookings/:id/check-out',
  requireRole('frontdesk'),
  validate({ ...bookingParam, body: z.strictObject({ lines: chargeLines.optional() }) }),
  ah(async (req, res) => {
    const today = todayIST();
    const actor = actorFrom(req);
    const out = await db.runTransaction(async (tx) => {
      const { ref, b, roomRef, room, owned } = await readStayContext(tx, req.params.id);
      if (b.state !== 'checked_in') throw conflict(CODES.INVALID_STATE, `A ${b.state} booking cannot be checked out`);
      const future = owned.filter((d) => d >= today);
      const rel = await prepareRelease(tx, { room, dates: future });
      const charges = req.body.lines ? await prepareCharges(tx, { bookingId: ref.id, booking: b }) : null;
      // writes
      tx.update(ref, { state: 'checked_out', checkedOutAt: FieldValue.serverTimestamp(), checkedOutBy: req.user.uid, earlyCheckout: future.length > 0, releasedNights: future.length });
      tx.update(roomRef, { status: 'cleaning', currentBookingId: null });
      const release = rel.apply(actor);
      const invoice = charges ? charges.apply({ lines: req.body.lines, actor }) : null;
      writeAudit(tx, actor, { action: 'booking.checkout', entity: 'booking', entityId: ref.id, before: { state: 'checked_in' }, after: { state: 'checked_out', releasedNights: future.length, invoiceId: invoice?.invoiceId ?? null } });
      return { release, invoice };
    });
    await notifyOffers(out.release.offers);
    res.json({
      booking: docJSON(await db.collection('bookings').doc(req.params.id).get()),
      invoiceId: out.invoice?.invoiceId ?? null,
      releasedNights: out.release.freed.length,
      offeredToQueue: out.release.offers.length,
    });
  }),
);

// POST /frontdesk/bookings/:id/no-show — after the check-in day ends; releases remaining nights.
router.post(
  '/frontdesk/bookings/:id/no-show',
  requireRole('frontdesk'),
  validate({ ...bookingParam, body: z.strictObject({ reason: zReason.optional() }) }),
  ah(async (req, res) => {
    const today = todayIST();
    const actor = actorFrom(req);
    const out = await db.runTransaction(async (tx) => {
      const { ref, b, room, owned } = await readStayContext(tx, req.params.id);
      if (b.state !== 'confirmed') throw conflict(CODES.INVALID_STATE, `A ${b.state} booking cannot be marked no-show`);
      if (today <= b.checkIn) throw unprocessable(CODES.INVALID_STATE, 'No-show can be marked only after the check-in day has ended');
      const rel = await prepareRelease(tx, { room, dates: owned.filter((d) => d >= today) });
      tx.update(ref, { state: 'no_show', noShowAt: FieldValue.serverTimestamp(), noShowBy: req.user.uid });
      const release = rel.apply(actor);
      writeAudit(tx, actor, { action: 'booking.noshow', entity: 'booking', entityId: ref.id, before: { state: 'confirmed' }, after: { state: 'no_show' }, reason: req.body.reason ?? null });
      return release;
    });
    await notifyOffers(out.offers);
    res.json({ booking: docJSON(await db.collection('bookings').doc(req.params.id).get()), offeredToQueue: out.offers.length });
  }),
);

// POST /frontdesk/rooms/:id/ready — cleaning -> available
router.post(
  '/frontdesk/rooms/:id/ready',
  requireRole('frontdesk'),
  validate({ params: z.object({ id: zId }), body: z.strictObject({}) }),
  ah(async (req, res) => {
    const ref = db.collection('rooms').doc(req.params.id);
    await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) throw notFound('Room');
      if (s.data().status !== 'cleaning') throw conflict(CODES.INVALID_STATE, `Room is ${s.data().status}, not cleaning`);
      tx.update(ref, { status: 'available', cleanedAt: FieldValue.serverTimestamp(), cleanedBy: req.user.uid });
      writeAudit(tx, actorFrom(req), { action: 'room.ready', entity: 'room', entityId: ref.id, before: { status: 'cleaning' }, after: { status: 'available' } });
    });
    res.json({ room: docJSON(await ref.get()) });
  }),
);
