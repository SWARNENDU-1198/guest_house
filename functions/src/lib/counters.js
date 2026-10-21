import { db } from '../firebase.js';

// Reads then increments counters/{name} inside a transaction. Because it reads,
// call it after all other reads of the transaction and before any write.
// Gap-free: the number is only used if the transaction commits.
export async function nextSeq(tx, name) {
  const ref = db.collection('counters').doc(name);
  const snap = await tx.get(ref);
  const value = (snap.exists ? snap.data().value : 0) + 1;
  tx.set(ref, { value });
  return value;
}

// Split form for transactions that must finish all reads before writing.
export async function readSeq(tx, name) {
  const ref = db.collection('counters').doc(name);
  const snap = await tx.get(ref);
  const value = (snap.exists ? snap.data().value : 0) + 1;
  return { value, commit: () => tx.set(ref, { value }) };
}

export const formatNumber = (prefix, year, n) => `${prefix}-${year}-${String(n).padStart(6, '0')}`;
