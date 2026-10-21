import { Router } from 'express';
import { z } from 'zod';
import { db, FieldValue, auth } from '../firebase.js';
import { ah, notFound } from '../middleware/errors.js';
import { requireProfile } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { writeAudit, actorFrom } from '../lib/audit.js';
import { syncClaims } from '../lib/claims.js';
import { docJSON } from '../lib/serialize.js';

export const router = Router();

// Public-safe profile shape (never includes refHash or raw Aadhaar data).
export function profileJSON(snap) {
  const u = docJSON(snap);
  if (!u) return null;
  return {
    uid: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone ?? null,
    role: u.role,
    categoryId: u.categoryId,
    status: u.status,
    officialStatus: u.officialStatus,
    verified: Boolean(u.aadhaar?.verifiedAt),
    aadhaar: u.aadhaar
      ? { last4: u.aadhaar.last4, verifiedName: u.aadhaar.verifiedName, birthYear: u.aadhaar.birthYear, method: u.aadhaar.method, verifiedAt: u.aadhaar.verifiedAt, signatureVerified: u.aadhaar.signatureVerified ?? null }
      : null,
    overdueOverride: u.overdueOverride ?? false,
    createdAt: u.createdAt,
  };
}

// POST /auth/bootstrap — idempotent. Creates users/{uid} as guest and sets claims.
router.post(
  '/auth/bootstrap',
  validate({ body: z.strictObject({ name: z.string().trim().min(1).max(100).optional(), phone: z.string().trim().regex(/^\+?\d{10,13}$/).optional() }) }),
  ah(async (req, res) => {
    const { uid, email, tokenName } = req.user;
    const ref = db.collection('users').doc(uid);
    let created = false;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return;
      const authUser = await auth.getUser(uid);
      const user = {
        name: req.body.name ?? tokenName ?? authUser.displayName ?? (email ? email.split('@')[0] : 'Guest'),
        email: email ?? authUser.email ?? null,
        phone: req.body.phone ?? authUser.phoneNumber ?? null,
        role: 'guest',
        categoryId: 'guest',
        status: 'active',
        officialStatus: 'none',
        aadhaar: null,
        createdAt: FieldValue.serverTimestamp(),
      };
      tx.create(ref, user);
      writeAudit(tx, { ...actorFrom(req), role: 'guest' }, { action: 'user.bootstrap', entity: 'user', entityId: uid, after: user });
      created = true;
    });
    const snap = await ref.get();
    const user = snap.data();
    // (Re)sync claims if missing or stale — makes a failed earlier attempt self-heal.
    if (req.user.role !== user.role || req.user.categoryId !== user.categoryId) await syncClaims(uid, user);
    res.status(created ? 201 : 200).json({ profile: profileJSON(snap), refreshToken: true });
  }),
);

router.get(
  '/me',
  requireProfile,
  ah(async (req, res) => {
    const snap = await db.collection('users').doc(req.user.uid).get();
    if (!snap.exists) throw notFound('Profile');
    res.json({ profile: profileJSON(snap) });
  }),
);
