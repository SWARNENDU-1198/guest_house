import { createHash } from 'node:crypto';
import { db, FieldValue } from '../firebase.js';
import { badRequest, conflict, CODES } from '../middleware/errors.js';

// Idempotency-Key support for POSTs that create bookings, payments or refunds.
// The first request with a key claims it; a repeat returns the stored response.
// A repeat while the first is still running gets 409. Failed requests release the key.
export function idempotent() {
  return async (req, res, next) => {
    const key = req.get('idempotency-key');
    if (!key) return next();
    if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(key)) return next(badRequest('Idempotency-Key must be 8-128 characters [A-Za-z0-9_.:-]'));
    const id = createHash('sha256').update(`${req.user?.uid}|${req.method}|${req.baseUrl}${req.path}|${key}`).digest('hex');
    const ref = db.collection('idempotencyKeys').doc(id);
    try {
      await ref.create({ uid: req.user?.uid ?? null, state: 'pending', createdAt: FieldValue.serverTimestamp() });
    } catch (e) {
      if (e.code !== 6) return next(e); // 6 = ALREADY_EXISTS
      const prev = (await ref.get()).data();
      if (prev?.state === 'done') {
        res.set('Idempotent-Replayed', 'true');
        return res.status(prev.status).json(JSON.parse(prev.body));
      }
      return next(conflict(CODES.INVALID_STATE, 'A request with this Idempotency-Key is still being processed'));
    }
    const json = res.json.bind(res);
    res.json = (body) => {
      const done = res.statusCode < 400
        ? ref.set({ uid: req.user?.uid ?? null, state: 'done', status: res.statusCode, body: JSON.stringify(body), createdAt: FieldValue.serverTimestamp() })
        : ref.delete();
      done.catch(() => {}).finally(() => json(body));
      return res;
    };
    next();
  };
}
