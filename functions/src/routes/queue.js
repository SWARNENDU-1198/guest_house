import { Router } from 'express';
import { z } from 'zod';
import { db, FieldValue } from '../firebase.js';
import { ah, notFound, conflict, unprocessable, CODES, badRequest } from '../middleware/errors.js';
import { requireRole } from '../middleware/requireRole.js';
import { validate, zId, zDate, zReason } from '../middleware/validate.js';
import { actorFrom, writeAudit } from '../lib/audit.js';
import { docJSON, toJSON } from '../lib/serialize.js';
import { readSeq } from '../lib/counters.js';
import { nightsBetween, diffDays, overlaps } from '../lib/dates.js';
import { nightRef } from '../lib/nights.js';
import { readBookerState, checkStayRules, runBookingTx } from '../lib/booking.js';
import { getSettings } from '../lib/settings.js';
import { ACTIVE_QUEUE_STATES, positionOf, queueOrder, waitingFor, notifyOffers, sweepRoomType } from '../lib/queue.js';
import { prepareRelease } from '../lib/release.js';
import { sendMail } from '../lib/mailer.js';
import { log } from '../lib/log.js';

export const router = Router();

const withPosition = async (entries) => {
  const settings = await getSettings();
  const types = [...new Set(entries.filter((e) => e.state === 'waiting').map((e) => e.roomTypeId))];
  const waitingByType = Object.fromEntries(await Promise.all(types.map(async (t) => [t, await waitingFor(t)])));
  return entries.map((e) => ({ ...toJSON(e), position: e.state === 'waiting' ? positionOf(e, waitingByType[e.roomTypeId], settings) : null }));
};

// POST /queue — { roomTypeId, checkIn, checkOut }
router.post(
  '/queue',
  validate({
    body: z
      .strictObject({ roomTypeId: zId, checkIn: zDate, checkOut: zDate })
      .refine((b) => b.checkOut > b.checkIn && diffDays(b.checkIn, b.checkOut) <= 90, { message: 'checkOut must be after checkIn', path: ['checkOut'] }),
  }),
  ah(async (req, res) => {
    const { roomTypeId, checkIn, checkOut } = req.body;
    const ref = db.collection('queue').doc();
    await runBookingTx(async (tx) => {
      const settings = await getSettings(tx);
      const { user, category } = await readBookerState(tx, req.user.uid);
      checkStayRules({ category, settings, checkIn, checkOut, activeCount: 0 });
      const type = await tx.get(db.collection('roomTypes').doc(roomTypeId));
      if (!type.exists || type.data().active === false) throw unprocessable(CODES.NOT_FOUND, 'Unknown room type');
      const mine = await tx.get(db.collection('queue').where('userId', '==', req.user.uid).where('state', 'in', ACTIVE_QUEUE_STATES));
      const clash = mine.docs.find((d) => overlaps(d.data().checkIn, d.data().checkOut, checkIn, checkOut));
      if (clash) throw conflict(CODES.ALREADY_QUEUED, 'You are already in the queue for overlapping dates', { queueId: clash.id });
      const seq = await readSeq(tx, 'queue');
      seq.commit();
      const entry = {
        userId: req.user.uid,
        userName: user.name,
        roomTypeId,
        checkIn,
        checkOut,
        seq: seq.value,
        requestedAt: FieldValue.serverTimestamp(),
        state: 'waiting',
        isOfficial: user.role === 'official' || Boolean(category.isFree),
        offer: null,
      };
      tx.create(ref, entry);
      writeAudit(tx, actorFrom(req), { action: 'queue.join', entity: 'queue', entityId: ref.id, after: entry });
    });
    // If a matching room is already free, the sweep offers it (to whoever is first in line).
    const offers = await sweepRoomType(roomTypeId, { actor: actorFrom(req) }).catch((e) => {
      log.error('queue.join.sweep', { err: e.message });
      return [];
    });
    await notifyOffers(offers);
    const [entry] = await withPosition([docJSON(await ref.get())]);
    res.status(201).json({ entry });
  }),
);

// GET /queue/me — my entries with live position and any active offer
router.get(
  '/queue/me',
  validate({ query: z.strictObject({ all: z.enum(['true', 'false']).optional() }) }),
  ah(async (req, res) => {
    let q = db.collection('queue').where('userId', '==', req.user.uid);
    if (req.q.all !== 'true') q = q.where('state', 'in', [...ACTIVE_QUEUE_STATES, 'accepted']);
    const snap = await q.get();
    const entries = snap.docs.map(docJSON).sort((a, b) => b.seq - a.seq);
    res.json({ items: await withPosition(entries) });
  }),
);

async function loadOwnEntry(tx, id, uid) {
  const ref = db.collection('queue').doc(id);
  const snap = await tx.get(ref);
  if (!snap.exists || snap.data().userId !== uid) throw notFound('Queue entry');
  return { ref, entry: { id: snap.id, ...snap.data() } };
}

// POST /queue/:id/accept — confirms a free offer, or returns the held booking to pay for.
router.post(
  '/queue/:id/accept',
  validate({ params: z.object({ id: zId }), body: z.strictObject({}) }),
  ah(async (req, res) => {
    const actor = actorFrom(req);
    const result = await db.runTransaction(async (tx) => {
      const { ref, entry } = await loadOwnEntry(tx, req.params.id, req.user.uid);
      if (entry.state === 'accepted') return { bookingId: entry.offer.bookingId };
      if (entry.state !== 'offered') throw conflict(CODES.INVALID_STATE, `Entry is ${entry.state}, there is no offer to accept`);
      const bookingRef = db.collection('bookings').doc(entry.offer.bookingId);
      const bs = await tx.get(bookingRef);
      const b = bs.data();
      if (!bs.exists || b.state !== 'held' || entry.offer.expiresAt.toMillis() <= Date.now()) {
        throw unprocessable(CODES.OFFER_EXPIRED, 'This offer has expired');
      }
      const dates = nightsBetween(b.checkIn, b.checkOut);
      if (b.isFree) {
        tx.update(bookingRef, { state: 'confirmed', holdExpiresAt: null, confirmedAt: FieldValue.serverTimestamp() });
        dates.forEach((d) => tx.update(nightRef(b.roomId, d), { state: 'booked' }));
        writeAudit(tx, actor, { action: 'booking.confirm', entity: 'booking', entityId: bookingRef.id, before: { state: 'held' }, after: { state: 'confirmed' }, reason: 'free offer accepted' });
      }
      tx.update(ref, { state: 'accepted', acceptedAt: FieldValue.serverTimestamp() });
      writeAudit(tx, actor, { action: 'queue.accept', entity: 'queue', entityId: ref.id, before: { state: 'offered' }, after: { state: 'accepted' } });
      return { bookingId: bookingRef.id };
    });
    const booking = docJSON(await db.collection('bookings').doc(result.bookingId).get());
    res.json({ booking, payNow: booking.state === 'held' });
  }),
);

// Shared by decline and leave: cancels the offer booking and passes the nights on.
async function giveUpEntry(req, { leaving }) {
  const actor = actorFrom(req);
  return runBookingTx(async (tx) => {
    const { ref, entry } = await loadOwnEntry(tx, req.params.id, req.user.uid);
    if (leaving && entry.state === 'waiting') {
      tx.update(ref, { state: 'removed', removedReason: 'left', removedAt: FieldValue.serverTimestamp() });
      writeAudit(tx, actor, { action: 'queue.leave', entity: 'queue', entityId: ref.id, before: { state: 'waiting' }, after: { state: 'removed' } });
      return { offers: [] };
    }
    if (!['offered', 'accepted'].includes(entry.state)) throw conflict(CODES.INVALID_STATE, `Entry is ${entry.state}`);
    const bookingRef = db.collection('bookings').doc(entry.offer.bookingId);
    const bs = await tx.get(bookingRef);
    const b = bs.data();
    if (b.state !== 'held') throw conflict(CODES.INVALID_STATE, 'The offer booking is already confirmed; cancel the booking instead');
    const dates = nightsBetween(b.checkIn, b.checkOut);
    const snaps = await tx.getAll(...dates.map((d) => nightRef(b.roomId, d)));
    const owned = snaps.filter((s) => s.exists && s.data().bookingId === bookingRef.id).map((s) => s.data().date);
    const room = await tx.get(db.collection('rooms').doc(b.roomId));
    const rel = await prepareRelease(tx, { room: { id: b.roomId, ...room.data() }, dates: owned });
    tx.update(bookingRef, { state: 'cancelled', cancelReason: 'queue offer declined', cancelledBy: req.user.uid, cancelledAt: FieldValue.serverTimestamp(), holdExpiresAt: null });
    tx.update(ref, { state: 'removed', removedReason: 'declined', removedAt: FieldValue.serverTimestamp() });
    const release = rel.apply(actor);
    writeAudit(tx, actor, { action: 'queue.decline', entity: 'queue', entityId: ref.id, before: { state: entry.state }, after: { state: 'removed' } });
    writeAudit(tx, actor, { action: 'booking.cancel', entity: 'booking', entityId: bookingRef.id, before: { state: 'held' }, after: { state: 'cancelled' }, reason: 'queue offer declined' });
    return { offers: release.offers };
  });
}

router.post(
  '/queue/:id/decline',
  validate({ params: z.object({ id: zId }), body: z.strictObject({}) }),
  ah(async (req, res) => {
    const r = await giveUpEntry(req, { leaving: false });
    await notifyOffers(r.offers);
    res.json({ declined: true, passedOn: r.offers.length > 0 });
  }),
);

router.delete(
  '/queue/:id',
  validate({ params: z.object({ id: zId }) }),
  ah(async (req, res) => {
    const r = await giveUpEntry(req, { leaving: true });
    await notifyOffers(r.offers);
    res.json({ removed: true });
  }),
);

// GET /admin/queue?roomTypeId — full ordered queue (waiting + offered)
router.get(
  '/admin/queue',
  requireRole('frontdesk', 'admin'),
  validate({ query: z.strictObject({ roomTypeId: zId.optional() }) }),
  ah(async (req, res) => {
    let q = db.collection('queue').where('state', 'in', ACTIVE_QUEUE_STATES);
    if (req.q.roomTypeId) q = q.where('roomTypeId', '==', req.q.roomTypeId);
    const settings = await getSettings();
    const entries = (await q.get()).docs.map(docJSON).sort((a, b) => (a.roomTypeId === b.roomTypeId ? queueOrder(settings)(a, b) : a.roomTypeId.localeCompare(b.roomTypeId)));
    res.json({ items: await withPosition(entries), officialsQueuePriority: settings.officialsQueuePriority });
  }),
);

// POST /admin/queue/:id/move — { newPosition, reason } among waiting entries of the same room type.
router.post(
  '/admin/queue/:id/move',
  requireRole('admin'),
  validate({ params: z.object({ id: zId }), body: z.strictObject({ newPosition: z.number().int().min(1), reason: zReason }) }),
  ah(async (req, res) => {
    const result = await db.runTransaction(async (tx) => {
      const ref = db.collection('queue').doc(req.params.id);
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound('Queue entry');
      const entry = { id: snap.id, ...snap.data() };
      if (entry.state !== 'waiting') throw conflict(CODES.INVALID_STATE, 'Only waiting entries can be moved');
      const settings = await getSettings(tx);
      const line = (await waitingFor(entry.roomTypeId, tx)).sort(queueOrder(settings));
      const oldPosition = line.findIndex((e) => e.id === entry.id) + 1;
      const others = line.filter((e) => e.id !== entry.id);
      const idx = Math.min(req.body.newPosition, others.length + 1) - 1;
      const prev = others[idx - 1];
      const next = others[idx];
      let seq;
      if (!prev && !next) seq = entry.seq;
      else if (!prev) seq = next.seq - 1;
      else if (!next) seq = prev.seq + 1;
      else seq = (prev.seq + next.seq) / 2;
      const user = await tx.get(db.collection('users').doc(entry.userId));
      tx.update(ref, { seq, movedAt: FieldValue.serverTimestamp(), movedBy: req.user.uid });
      writeAudit(tx, actorFrom(req), { action: 'queue.move', entity: 'queue', entityId: ref.id, before: { seq: entry.seq, position: oldPosition }, after: { seq, position: idx + 1 }, reason: req.body.reason });
      return { email: user.data()?.email, oldPosition, newPosition: idx + 1, entry };
    });
    await sendMail({
      to: result.email,
      tag: 'queue.move',
      subject: 'Your place in the room queue changed',
      text: `Your queue position for ${result.entry.checkIn} to ${result.entry.checkOut} moved from ${result.oldPosition} to ${result.newPosition}. Reason: ${req.body.reason}`,
    });
    const [entry] = await withPosition([docJSON(await db.collection('queue').doc(req.params.id).get())]);
    res.json({ entry });
  }),
);

export { badRequest };
