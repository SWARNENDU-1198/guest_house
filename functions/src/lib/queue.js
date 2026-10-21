import { db, FieldValue, Timestamp } from '../firebase.js';
import { writeAudit } from './audit.js';
import { nightsBetween, todayIST, overlaps } from './dates.js';
import { nightRef } from './nights.js';
import { priceStay, rateSnapshot, rateRef } from './pricing.js';
import { bookingCode, pickFreeRoom } from './booking.js';
import { getSettings } from './settings.js';
import { readSeq } from './counters.js';
import { sendQueueOffer } from './notify.js';
import { log } from './log.js';

export const ACTIVE_QUEUE_STATES = ['waiting', 'offered'];

// Queue order: seq ascending; with officialsQueuePriority, officials first.
export const queueOrder = (settings) => (a, b) => {
  if (settings.officialsQueuePriority && Boolean(a.isOfficial) !== Boolean(b.isOfficial)) return a.isOfficial ? -1 : 1;
  return a.seq - b.seq;
};

// Position is computed, not stored: waiting entries of the same room type with
// overlapping dates that are ahead in queue order, plus one.
export function positionOf(entry, waiting, settings) {
  const cmp = queueOrder(settings);
  return (
    waiting.filter((w) => w.id !== entry.id && w.roomTypeId === entry.roomTypeId && overlaps(w.checkIn, w.checkOut, entry.checkIn, entry.checkOut) && cmp(w, entry) < 0).length + 1
  );
}

export async function waitingFor(roomTypeId, tx = null) {
  const q = db.collection('queue').where('roomTypeId', '==', roomTypeId).where('state', '==', 'waiting').orderBy('seq');
  const snap = tx ? await tx.get(q) : await q.get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// Read phase for offers: loads what writeOffer needs for one queue entry.
// Returns null if this entry can't be offered (suspended user, no rate, ...).
export async function readOfferContext(tx, entry) {
  const userSnap = await tx.get(db.collection('users').doc(entry.userId));
  if (!userSnap.exists) return null;
  const user = userSnap.data();
  if (user.status === 'suspended') return null;
  const catSnap = await tx.get(db.collection('categories').doc(user.categoryId || 'guest'));
  if (!catSnap.exists) return null;
  const category = { id: catSnap.id, ...catSnap.data() };
  const rate = await tx.get(rateRef(category.id, entry.roomTypeId));
  return { user, category, rate: rate.exists ? rate.data() : null };
}

// Write phase: creates the held offer booking, locks its nights (overwriting
// the freed ones so the room never shows as free), and marks the entry offered.
export function writeOffer(tx, { entry, ctx, room, dates, existing, seqValue, settings, actor }) {
  let price;
  try {
    price = priceStay({ category: ctx.category, rate: ctx.rate, nights: dates.length, taxPercent: settings.taxPercent });
  } catch {
    return null;
  }
  const bookingRef = db.collection('bookings').doc();
  const expiresAt = Timestamp.fromMillis(Date.now() + settings.offerMinutes * 60_000);
  const booking = {
    userId: entry.userId,
    userName: ctx.user.name,
    roomId: room.id,
    roomNumber: room.number,
    buildingId: room.buildingId,
    roomTypeId: room.roomTypeId,
    categoryId: ctx.category.id,
    checkIn: entry.checkIn,
    checkOut: entry.checkOut,
    nights: dates.length,
    state: 'held',
    seq: seqValue,
    code: bookingCode(seqValue),
    requestedAt: FieldValue.serverTimestamp(),
    holdExpiresAt: expiresAt,
    confirmedAt: null,
    rateSnapshot: rateSnapshot({ categoryId: ctx.category.id, roomTypeId: room.roomTypeId, price }),
    amountPaise: price.totalPaise,
    paidPaise: 0,
    isFree: price.isFree,
    payLater: false,
    createdBy: 'system',
    cancelReason: null,
    offerQueueId: entry.id,
  };
  tx.create(bookingRef, booking);
  dates.forEach((d) => {
    const data = { roomId: room.id, roomTypeId: room.roomTypeId, buildingId: room.buildingId, date: d, bookingId: bookingRef.id, state: 'held' };
    if (existing.has(d)) tx.set(nightRef(room.id, d), data);
    else tx.create(nightRef(room.id, d), data);
  });
  const offer = { roomId: room.id, roomNumber: room.number, bookingId: bookingRef.id, expiresAt, amountPaise: price.totalPaise };
  tx.update(db.collection('queue').doc(entry.id), { state: 'offered', offer, offeredAt: FieldValue.serverTimestamp() });
  writeAudit(tx, actor, { action: 'queue.offer', entity: 'queue', entityId: entry.id, before: { state: 'waiting' }, after: { state: 'offered', roomId: room.id, bookingId: bookingRef.id } });
  writeAudit(tx, actor, { action: 'booking.create', entity: 'booking', entityId: bookingRef.id, after: booking, reason: 'queue offer' });
  return { queueId: entry.id, userId: entry.userId, email: ctx.user.email, bookingId: bookingRef.id, roomId: room.id, roomNumber: room.number, expiresAt: expiresAt.toDate().toISOString(), amountPaise: price.totalPaise, checkIn: entry.checkIn, checkOut: entry.checkOut };
}

// Email + (via the queue doc's onSnapshot) in-app notification. Best-effort, after commit.
export async function notifyOffers(offers = []) {
  for (const o of offers) {
    await sendQueueOffer(o).catch((e) => log.error('notifyOffers', { err: e.message }));
  }
}

// Safety sweep for one room type: offers any free room to waiting entries in queue order.
// Each offer is its own transaction that re-checks everything.
export async function sweepRoomType(roomTypeId, { actor }) {
  const settings = await getSettings();
  const waiting = (await waitingFor(roomTypeId)).sort(queueOrder(settings));
  const offers = [];
  const today = todayIST();
  for (const w of waiting) {
    if (w.checkIn < today) continue;
    try {
      const offer = await db.runTransaction(async (tx) => {
        const ref = db.collection('queue').doc(w.id);
        const snap = await tx.get(ref);
        if (!snap.exists || snap.data().state !== 'waiting') return null;
        const entry = { id: snap.id, ...snap.data() };
        const s = await getSettings(tx);
        // Someone ahead in line with overlapping dates still waiting? They go first.
        const ahead = (await waitingFor(roomTypeId, tx)).filter((x) => x.id !== entry.id && overlaps(x.checkIn, x.checkOut, entry.checkIn, entry.checkOut) && queueOrder(s)(x, entry) < 0 && x.checkIn >= today);
        const dates = nightsBetween(entry.checkIn, entry.checkOut);
        const pick = await pickFreeRoom(tx, { roomTypeId, dates });
        if (!pick) return null;
        if (ahead.length) {
          // only offer if the room would not suit anyone ahead (their dates must not fit it)
          for (const a of ahead) {
            const aDates = nightsBetween(a.checkIn, a.checkOut);
            const snaps = await tx.getAll(...aDates.map((d) => nightRef(pick.room.id, d)));
            if (snaps.every((x) => !x.exists)) return null;
          }
        }
        const ctx = await readOfferContext(tx, entry);
        if (!ctx) return null;
        const seq = await readSeq(tx, 'bookings');
        seq.commit();
        return writeOffer(tx, { entry, ctx, room: { id: pick.room.id, ...pick.room.data() }, dates, existing: new Set(), seqValue: seq.value, settings: s, actor });
      });
      if (offer) offers.push(offer);
    } catch (e) {
      log.error('sweep.failed', { queueId: w.id, err: e.message });
    }
  }
  return offers;
}
