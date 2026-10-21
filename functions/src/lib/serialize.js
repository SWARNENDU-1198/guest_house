import { Timestamp } from '../firebase.js';

// Firestore values -> JSON (Timestamps become ISO strings).
export function toJSON(value) {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJSON);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJSON(v);
    return out;
  }
  return value;
}

export const docJSON = (snap) => (snap?.exists ? { id: snap.id, ...toJSON(snap.data()) } : null);

// Cursor pagination: ?limit=20&cursor=<lastDocId>
export async function paginate(query, collectionRef, { limit = 20, cursor } = {}) {
  let q = query;
  if (cursor) {
    const cur = await collectionRef.doc(cursor).get();
    if (cur.exists) q = q.startAfter(cur);
  }
  const snap = await q.limit(limit + 1).get();
  const docs = snap.docs.slice(0, limit);
  return {
    items: docs.map(docJSON),
    nextCursor: snap.docs.length > limit ? docs[docs.length - 1].id : null,
  };
}
