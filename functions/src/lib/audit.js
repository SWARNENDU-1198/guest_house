import { db, FieldValue, Timestamp } from '../firebase.js';

// Keys that must never reach the audit trail.
const DROP = new Set(['aadhaar', 'qrData', 'qr', 'password', 'token', 'signature', 'razorpay_signature', 'refHash', 'secret', 'photo']);

export function sanitize(value, depth = 0) {
  if (value === undefined) return null;
  if (value === null || depth > 8) return value;
  if (value instanceof Timestamp || value instanceof Date) return value;
  if (value instanceof FieldValue) return '(server value)';
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROP.has(k) || v === undefined) continue;
      out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

export const actorFrom = (req) => ({
  uid: req.user?.uid ?? null,
  role: req.user?.role ?? null,
  ip: req.ip ?? null,
  userAgent: req.get?.('user-agent') ?? null,
});

export const SYSTEM_ACTOR = { uid: 'system', role: 'system', ip: null, userAgent: 'scheduler' };

// Must be called inside the same transaction as the change it records.
export function writeAudit(tx, actor, { action, entity, entityId, before = null, after = null, reason = null }) {
  const ref = db.collection('auditLogs').doc();
  tx.create(ref, {
    actorUid: actor?.uid ?? null,
    actorRole: actor?.role ?? null,
    action,
    entity,
    entityId: String(entityId),
    before: sanitize(before),
    after: sanitize(after),
    reason: reason ?? null,
    ip: actor?.ip ?? null,
    userAgent: actor?.userAgent ? String(actor.userAgent).slice(0, 300) : null,
    at: FieldValue.serverTimestamp(),
  });
  return ref.id;
}
