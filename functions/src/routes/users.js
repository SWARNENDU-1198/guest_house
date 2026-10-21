import { Router } from 'express';
import { z } from 'zod';
import { db } from '../firebase.js';
import { ah, notFound, unprocessable, CODES } from '../middleware/errors.js';
import { requireRole } from '../middleware/requireRole.js';
import { validate, zId, zReason } from '../middleware/validate.js';
import { writeAudit, actorFrom } from '../lib/audit.js';
import { syncClaims } from '../lib/claims.js';
import { ROLES } from '../config.js';
import { profileJSON } from './me.js';

export const router = Router();

// POST /admin/users/:uid/role — set role (claims + doc), revoke tokens, audit.
router.post(
  '/admin/users/:uid/role',
  requireRole('admin'),
  validate({ params: z.object({ uid: zId }), body: z.strictObject({ role: z.enum(ROLES), reason: zReason.optional() }) }),
  ah(async (req, res) => {
    const { uid } = req.params;
    if (uid === req.user.uid) throw unprocessable(CODES.FORBIDDEN, 'Admins cannot change their own role');
    const ref = db.collection('users').doc(uid);
    const updated = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound('User');
      const before = snap.data();
      const after = { ...before, role: req.body.role };
      tx.update(ref, { role: req.body.role });
      writeAudit(tx, actorFrom(req), {
        action: 'user.role.change',
        entity: 'user',
        entityId: uid,
        before: { role: before.role },
        after: { role: after.role },
        reason: req.body.reason,
      });
      return after;
    });
    await syncClaims(uid, updated, { revoke: true });
    res.json({ profile: profileJSON(await ref.get()) });
  }),
);
