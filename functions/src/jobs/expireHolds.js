import { db, FieldValue, Timestamp } from '../firebase.js';
import { SYSTEM_ACTOR, writeAudit } from '../lib/audit.js';
import { nightsBetween } from '../lib/dates.js';
import { nightRef } from '../lib/nights.js';
import { prepareRelease } from '../lib/release.js';
import { log } from '../lib/log.js';
import { notifyOffers } from '../lib/queue.js';

// Expires held bookings past holdExpiresAt (normal holds and queue offers) and
// releases their nights, which offers them to the queue first.
export async function expireHolds({ now = Date.now(), limit = 200, notify = true } = {}) {
  const due = await db
    .collection('bookings')
    .where('state', '==', 'held')
    .where('holdExpiresAt', '<=', Timestamp.fromMillis(now))
    .orderBy('holdExpiresAt')
    .limit(limit)
    .get();
  let expired = 0;
  const offers = [];
  for (const doc of due.docs) {
    try {
      const did = await db.runTransaction(async (tx) => expireOne(tx, doc.ref, now));
      if (did) {
        expired += 1;
        offers.push(...did.offers);
      }
    } catch (e) {
      log.error('expireHolds.failed', { bookingId: doc.id, err: e.message });
    }
  }
  if (notify) await notifyOffers(offers);
  return { checked: due.size, expired, offers };
}

export async function expireOne(tx, ref, now = Date.now()) {
  const snap = await tx.get(ref);
  const b = snap.data();
  if (!snap.exists || b.state !== 'held' || !b.holdExpiresAt || b.holdExpiresAt.toMillis() > now) return false;
  const dates = nightsBetween(b.checkIn, b.checkOut);
  const nightSnaps = await tx.getAll(...dates.map((d) => nightRef(b.roomId, d)));
  const owned = nightSnaps.filter((s) => s.exists && s.data().bookingId === ref.id).map((s) => s.data().date);
  const queueRef = b.offerQueueId ? db.collection('queue').doc(b.offerQueueId) : null;
  const queueSnap = queueRef ? await tx.get(queueRef) : null;
  const room = await tx.get(db.collection('rooms').doc(b.roomId));
  const rel = await prepareRelease(tx, { room: { id: b.roomId, ...room.data() }, dates: owned });
  // writes
  tx.update(ref, { state: 'expired', expiredAt: FieldValue.serverTimestamp() });
  if (queueSnap?.exists && ['offered', 'accepted'].includes(queueSnap.data().state)) {
    tx.update(queueRef, { state: 'expired', expiredAt: FieldValue.serverTimestamp() });
    writeAudit(tx, SYSTEM_ACTOR, { action: 'queue.offer.expire', entity: 'queue', entityId: queueRef.id, before: { state: queueSnap.data().state }, after: { state: 'expired' } });
  }
  const release = rel.apply(SYSTEM_ACTOR);
  writeAudit(tx, SYSTEM_ACTOR, { action: b.offerQueueId ? 'booking.offer.expire' : 'booking.hold.expire', entity: 'booking', entityId: ref.id, before: { state: 'held' }, after: { state: 'expired' } });
  return { offers: release.offers };
}
