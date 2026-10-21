import { nightRef } from './nights.js';

// Frees nights of a room. v0.5 replaces this with "offer to the queue first".
// Must be called after all other reads of the transaction (it only writes here).
export async function releaseNights(tx, { room, dates }) {
  for (const d of dates) tx.delete(nightRef(room.id, d));
  return { offers: [], freed: dates };
}
