import { db } from '../firebase.js';
import { nightsBetween, todayIST } from './dates.js';
import { nightRef } from './nights.js';
import { getSettings } from './settings.js';
import { readSeq } from './counters.js';
import { queueOrder, readOfferContext, writeOffer } from './queue.js';

// Every path that frees nights (cancel, hold expiry, unblock, early checkout,
// no-show, admin move) goes through here. Freed nights are offered to the
// queue FIRST, inside the same transaction: nights an offer uses are converted
// to held for that user instead of being deleted, so the room never shows as
// free to anyone else.
//
// Two-phase because Firestore transactions need all reads before any write:
//   const rel = await prepareRelease(tx, {...});   // reads
//   ...other reads...
//   rel.apply(actor);                               // writes
//
// reservedDates: nights of this room that the same transaction is about to
// create itself (never offered).
export async function prepareRelease(tx, { room, dates, reservedDates = [] }) {
  const freed = [...new Set(dates)].sort();
  if (!freed.length) return { apply: () => ({ offers: [], freed: [] }) };

  const settings = await getSettings(tx);
  const today = todayIST();
  const plans = [];
  const roomUsable = room.active !== false && room.status !== 'blocked';

  if (roomUsable) {
    const q = db.collection('queue').where('roomTypeId', '==', room.roomTypeId).where('state', '==', 'waiting').orderBy('seq').limit(50);
    const waiting = (await tx.get(q)).docs.map((d) => ({ id: d.id, ...d.data() })).filter((w) => w.checkIn >= today).sort(queueOrder(settings));
    const freedSet = new Set(freed);
    const reserved = new Set(reservedDates);
    // Which other nights of this room do candidates need? Read them once.
    const extra = new Set();
    for (const w of waiting) for (const d of nightsBetween(w.checkIn, w.checkOut)) if (!freedSet.has(d)) extra.add(d);
    const extraList = [...extra];
    const extraSnaps = extraList.length ? await tx.getAll(...extraList.map((d) => nightRef(room.id, d))) : [];
    const free = new Set([...freed, ...extraList.filter((d, i) => !extraSnaps[i].exists)].filter((d) => !reserved.has(d)));

    for (const w of waiting) {
      const need = nightsBetween(w.checkIn, w.checkOut);
      if (!need.some((d) => freedSet.has(d))) continue; // leave unrelated matches to the sweep
      if (!need.every((d) => free.has(d))) continue;
      const ctx = await readOfferContext(tx, w);
      if (!ctx) continue;
      need.forEach((d) => free.delete(d));
      plans.push({ entry: w, ctx, dates: need });
    }
  }
  const seq = plans.length ? await readSeq(tx, 'bookings') : null;

  return {
    apply(actor) {
      const used = new Set();
      const offers = [];
      plans.forEach((p, i) => {
        const existing = new Set(p.dates.filter((d) => freed.includes(d)));
        const offer = writeOffer(tx, { entry: p.entry, ctx: p.ctx, room, dates: p.dates, existing, seqValue: seq.value + i, settings, actor });
        if (offer) {
          offers.push(offer);
          p.dates.forEach((d) => used.add(d));
        }
      });
      if (seq) tx.set(db.collection('counters').doc('bookings'), { value: seq.value + plans.length - 1 });
      for (const d of freed) if (!used.has(d)) tx.delete(nightRef(room.id, d));
      return { offers, freed: freed.filter((d) => !used.has(d)) };
    },
  };
}
