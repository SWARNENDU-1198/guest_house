import { db, FieldValue } from '../firebase.js';
import { SYSTEM_ACTOR, writeAudit } from '../lib/audit.js';
import { todayIST } from '../lib/dates.js';
import { notifyOffers, sweepRoomType } from '../lib/queue.js';
import { log } from '../lib/log.js';
import { expireHolds } from './expireHolds.js';

// Every minute:
//  1. expire held bookings past holdExpiresAt (normal holds and offers) -> release -> offer to queue
//  2. expire offered entries whose offer lapsed but whose booking is no longer held
//  3. expire waiting entries whose check-in date has passed
//  4. safety sweep: offer any free matching room to waiting entries
export async function processQueue({ now = Date.now() } = {}) {
  const holds = await expireHolds({ now, notify: false });
  const offers = [...holds.offers];
  let staleOffers = 0;
  let staleWaiting = 0;

  const offered = await db.collection('queue').where('state', '==', 'offered').get();
  for (const doc of offered.docs) {
    if (doc.data().offer?.expiresAt?.toMillis() > now) continue;
    await db
      .runTransaction(async (tx) => {
        const s = await tx.get(doc.ref);
        const e = s.data();
        if (e.state !== 'offered' || e.offer.expiresAt.toMillis() > now) return;
        const b = await tx.get(db.collection('bookings').doc(e.offer.bookingId));
        if (b.exists && ['held', 'confirmed', 'checked_in'].includes(b.data().state)) return; // the hold expiry handles it
        tx.update(doc.ref, { state: 'expired', expiredAt: FieldValue.serverTimestamp() });
        writeAudit(tx, SYSTEM_ACTOR, { action: 'queue.offer.expire', entity: 'queue', entityId: doc.id, before: { state: 'offered' }, after: { state: 'expired' } });
        staleOffers += 1;
      })
      .catch((e) => log.error('processQueue.offer', { err: e.message }));
  }

  const today = todayIST(now);
  const waiting = await db.collection('queue').where('state', '==', 'waiting').get();
  const types = new Set();
  for (const doc of waiting.docs) {
    if (doc.data().checkIn >= today) {
      types.add(doc.data().roomTypeId);
      continue;
    }
    await db
      .runTransaction(async (tx) => {
        const s = await tx.get(doc.ref);
        if (s.data().state !== 'waiting') return;
        tx.update(doc.ref, { state: 'expired', expiredAt: FieldValue.serverTimestamp(), removedReason: 'dates passed' });
        writeAudit(tx, SYSTEM_ACTOR, { action: 'queue.expire', entity: 'queue', entityId: doc.id, before: { state: 'waiting' }, after: { state: 'expired' }, reason: 'check-in date passed' });
        staleWaiting += 1;
      })
      .catch((e) => log.error('processQueue.waiting', { err: e.message }));
  }

  for (const t of types) offers.push(...(await sweepRoomType(t, { actor: SYSTEM_ACTOR })));
  await notifyOffers(offers);
  return { expiredHolds: holds.expired, staleOffers, staleWaiting, offers: offers.length };
}
