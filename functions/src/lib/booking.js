import { db, FieldValue, Timestamp } from '../firebase.js';
import { ApiError, conflict, forbidden, notFound, unprocessable, CODES } from '../middleware/errors.js';
import { writeAudit } from './audit.js';
import { readSeq } from './counters.js';
import { nightsBetween, todayIST, diffDays, istMidnight } from './dates.js';
import { nightRef } from './nights.js';
import { priceStay, rateSnapshot, rateRef } from './pricing.js';
import { getSettings } from './settings.js';
import { prepareInvoice } from './invoicing.js';
import { prepareReceipt } from './receipts.js';

export const ACTIVE_STATES = ['held', 'confirmed', 'checked_in'];
export const CHECK_IN_HOUR_IST = 12;

export const bookingCode = (seq) => `BK-${String(seq).padStart(6, '0')}`;

const isAlreadyExists = (e) => e?.code === 6 || /already exists/i.test(e?.message ?? '');
const isContention = (e) => e?.code === 10 || /aborted|contention|too much contention/i.test(e?.message ?? '');

// Runs a booking transaction; a lost race (night created by someone else at
// commit time) becomes ROOM_TAKEN, and contention is retried.
export async function runBookingTx(fn, { attempts = 6 } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await db.runTransaction(fn, { maxAttempts: 10 });
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (isAlreadyExists(e)) throw conflict(CODES.ROOM_TAKEN, 'That room was just taken for those dates', { canQueue: true });
      if (isContention(e) && i < attempts) {
        await new Promise((r) => setTimeout(r, 20 * i + Math.random() * 50));
        continue;
      }
      throw e;
    }
  }
}

// --- read phase helpers -----------------------------------------------------

export async function readBookerState(tx, userId, { overrides = {} } = {}) {
  const userSnap = await tx.get(db.collection('users').doc(userId));
  if (!userSnap.exists) throw notFound('User');
  const user = { id: userSnap.id, ...userSnap.data() };
  if (user.status === 'suspended') throw forbidden('This account is suspended', CODES.SUSPENDED);
  if (!user.aadhaar?.verifiedAt && !overrides.verification) throw forbidden('Verify your Aadhaar before booking', CODES.UNVERIFIED);
  const [overdue, active] = await Promise.all([
    tx.get(db.collection('invoices').where('userId', '==', userId).where('status', '==', 'overdue').limit(1)),
    tx.get(db.collection('bookings').where('userId', '==', userId).where('state', 'in', ACTIVE_STATES)),
  ]);
  if (!overdue.empty && !user.overdueOverride && !overrides.overdue) {
    throw unprocessable(CODES.OVERDUE_INVOICE, 'You have an overdue invoice. Pay it before booking again.', { invoiceId: overdue.docs[0].id });
  }
  const categorySnap = await tx.get(db.collection('categories').doc(user.categoryId || 'guest'));
  if (!categorySnap.exists) throw unprocessable(CODES.NOT_FOUND, 'Your category no longer exists; contact the office');
  return { user, category: { id: categorySnap.id, ...categorySnap.data() }, activeCount: active.size };
}

export function checkStayRules({ category, settings, checkIn, checkOut, activeCount, overrides = {} }) {
  const nights = diffDays(checkIn, checkOut);
  const today = todayIST();
  if (nights < 1) throw unprocessable(CODES.LIMIT_EXCEEDED, 'Stay must be at least one night');
  if (!overrides.limits && nights > category.maxNights) {
    throw unprocessable(CODES.LIMIT_EXCEEDED, `Your category allows at most ${category.maxNights} nights`, { maxNights: category.maxNights });
  }
  if (!overrides.advance) {
    if (checkIn < today) throw unprocessable(CODES.LIMIT_EXCEEDED, 'Check-in date is in the past');
    if (diffDays(today, checkIn) > category.maxAdvanceDays) {
      throw unprocessable(CODES.LIMIT_EXCEEDED, `You can book at most ${category.maxAdvanceDays} days ahead`, { maxAdvanceDays: category.maxAdvanceDays });
    }
  }
  if (!overrides.limits && activeCount >= settings.maxActiveBookings) {
    throw unprocessable(CODES.LIMIT_EXCEEDED, `At most ${settings.maxActiveBookings} active bookings at a time`, { maxActiveBookings: settings.maxActiveBookings });
  }
}

const usableRoom = (snap) => snap.exists && snap.data().active !== false && snap.data().status !== 'blocked';

// Reads the nights of one room; returns refs if all free (or owned by allowBookingId).
export async function readFreeNights(tx, roomId, dates, { allowBookingId = null } = {}) {
  const refs = dates.map((d) => nightRef(roomId, d));
  const snaps = await tx.getAll(...refs);
  const free = snaps.every((s) => !s.exists || (allowBookingId && s.data().bookingId === allowBookingId));
  return { refs, snaps, free };
}

// Picks the first room of a type that is free for every night.
export async function pickFreeRoom(tx, { roomTypeId, buildingId, dates }) {
  let q = db.collection('rooms').where('roomTypeId', '==', roomTypeId).where('active', '==', true);
  if (buildingId) q = q.where('buildingId', '==', buildingId);
  const rooms = (await tx.get(q)).docs.filter(usableRoom).sort((a, b) => a.data().number.localeCompare(b.data().number, 'en', { numeric: true }));
  for (const room of rooms) {
    const nights = await readFreeNights(tx, room.id, dates);
    if (nights.free) return { room, nights };
  }
  return null;
}

// --- the booking transaction -------------------------------------------------
// Reads everything first, then writes: booking + one roomNights doc per night +
// audit (+ invoice for pay-later). tx.create on a night fails if it exists.
export async function createBooking(tx, { actor, userId, roomId, roomTypeId, buildingId, checkIn, checkOut, payLater = false, overrides = {}, reason = null, createdBy }) {
  const dates = nightsBetween(checkIn, checkOut);
  const settings = await getSettings(tx);
  const { user, category, activeCount } = await readBookerState(tx, userId, { overrides });
  checkStayRules({ category, settings, checkIn, checkOut, activeCount, overrides });

  let room;
  let nights;
  if (roomId) {
    const snap = await tx.get(db.collection('rooms').doc(roomId));
    if (!snap.exists) throw notFound('Room');
    if (!usableRoom(snap)) throw unprocessable(CODES.ROOM_TAKEN, 'This room is not available for booking');
    room = snap;
    nights = await readFreeNights(tx, roomId, dates);
    if (!nights.free) {
      throw conflict(CODES.ROOM_TAKEN, 'That room is already taken for some of those nights', {
        dates: nights.snaps.filter((s) => s.exists).map((s) => s.data().date),
        canQueue: true,
      });
    }
  } else {
    const pick = await pickFreeRoom(tx, { roomTypeId, buildingId, dates });
    if (!pick) throw conflict(CODES.ROOM_TAKEN, 'No room of that type is free for those dates. Join the queue to get the next one.', { canQueue: true });
    ({ room, nights } = pick);
  }
  const r = room.data();
  const rateSnap = await tx.get(rateRef(category.id, r.roomTypeId));
  const price = priceStay({ category, rate: rateSnap.exists ? rateSnap.data() : null, nights: dates.length, taxPercent: settings.taxPercent });

  const usePayLater = payLater && !price.isFree;
  if (usePayLater && !category.payLaterAllowed) throw unprocessable(CODES.FORBIDDEN, 'Your category cannot pay later');
  const instant = price.isFree || usePayLater;

  const seq = await readSeq(tx, 'bookings');
  const invoicePrep = usePayLater ? await prepareInvoice(tx) : null;
  const slipPrep = price.isFree ? await prepareReceipt(tx, { kind: 'slip', userId, booking: { roomTypeId: r.roomTypeId, buildingId: r.buildingId } }) : null;
  // ---- writes ----
  seq.commit();
  const bookingRef = db.collection('bookings').doc();
  const now = Date.now();
  const booking = {
    userId,
    userName: user.name,
    roomId: room.id,
    roomNumber: r.number,
    buildingId: r.buildingId,
    roomTypeId: r.roomTypeId,
    categoryId: category.id,
    checkIn,
    checkOut,
    nights: dates.length,
    state: instant ? 'confirmed' : 'held',
    seq: seq.value,
    code: bookingCode(seq.value),
    requestedAt: FieldValue.serverTimestamp(),
    holdExpiresAt: instant ? null : Timestamp.fromMillis(now + settings.holdMinutes * 60_000),
    confirmedAt: instant ? FieldValue.serverTimestamp() : null,
    rateSnapshot: rateSnapshot({ categoryId: category.id, roomTypeId: r.roomTypeId, price }),
    amountPaise: price.totalPaise,
    paidPaise: 0,
    isFree: price.isFree,
    payLater: usePayLater,
    createdBy,
    overrides: Object.keys(overrides).length ? overrides : null,
    overrideReason: reason,
    cancelReason: null,
    offerQueueId: null,
  };
  tx.create(bookingRef, booking);
  nights.refs.forEach((ref, i) =>
    tx.create(ref, { roomId: room.id, roomTypeId: r.roomTypeId, buildingId: r.buildingId, date: dates[i], bookingId: bookingRef.id, state: instant ? 'booked' : 'held' }),
  );
  writeAudit(tx, actor, { action: 'booking.create', entity: 'booking', entityId: bookingRef.id, after: booking, reason });
  let invoiceId = null;
  let slip = null;
  if (slipPrep) slip = slipPrep.write({ booking, actor, bookingId: bookingRef.id, totalPaise: 0, note: 'Free stay (category rate 0)' });
  if (invoicePrep) {
    invoiceId = invoicePrep.write({
      actor,
      userId,
      bookingId: bookingRef.id,
      lines: [{ label: `Room ${r.number}, ${dates.length} night(s) ${checkIn} to ${checkOut}`, amountPaise: price.totalPaise }],
      settings,
    });
  }
  return { id: bookingRef.id, ...booking, invoiceId, slipId: slip?.id ?? null, holdExpiresAt: booking.holdExpiresAt };
}

// Refund due on cancellation per settings.refundPolicy (hours before check-in at noon IST).
export function refundDue({ booking, settings, now = Date.now() }) {
  const paid = booking.paidPaise ?? 0;
  if (!paid) return { percent: 0, amountPaise: 0, hoursBefore: null };
  const checkInAt = istMidnight(booking.checkIn).getTime() + CHECK_IN_HOUR_IST * 3_600_000;
  const hoursBefore = (checkInAt - now) / 3_600_000;
  const rules = [...settings.refundPolicy].sort((a, b) => b.hoursBefore - a.hoursBefore);
  const rule = rules.find((r) => hoursBefore >= r.hoursBefore);
  const percent = rule ? rule.percent : 0;
  return { percent, amountPaise: Math.floor((paid * percent) / 100), hoursBefore: Math.floor(hoursBefore) };
}

export const canSeeBooking = (user, booking) => booking.userId === user.uid || ['frontdesk', 'accounts', 'admin'].includes(user.role);
