import { nightRef } from './nights.js';

// Two-phase release of a room's nights (Firestore transactions need all reads
// before any write). prepareRelease does the reads; apply() does the writes.
// v0.5 replaces the body with "offer to the queue first".
export async function prepareRelease(tx, { room, dates }) {
  return {
    apply() {
      for (const d of dates) tx.delete(nightRef(room.id, d));
      return { offers: [], freed: dates };
    },
  };
}
