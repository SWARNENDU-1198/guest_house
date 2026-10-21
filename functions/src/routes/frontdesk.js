import { Router } from 'express';
import { z } from 'zod';
import { db, auth, FieldValue } from '../firebase.js';
import { ah, conflict, unprocessable, CODES } from '../middleware/errors.js';
import { requireRole } from '../middleware/requireRole.js';
import { validate } from '../middleware/validate.js';
import { writeAudit, actorFrom } from '../lib/audit.js';
import { syncClaims } from '../lib/claims.js';
import { decodeSecureQr, namesMatch } from '../lib/aadhaarQr.js';
import { checkAadhaarFree, writeAadhaar } from '../lib/verification.js';
import { profileJSON } from './me.js';

export const router = Router();

// POST /frontdesk/walk-in — create a verified guest at the counter.
router.post(
  '/frontdesk/walk-in',
  requireRole('frontdesk'),
  validate({
    body: z.strictObject({
      name: z.string().trim().min(1).max(100),
      phone: z.string().trim().regex(/^\+?\d{10,13}$/),
      email: z.email().max(200),
      qrData: z.string().min(1).max(12000),
      consent: z.literal(true, { error: 'Guest consent is required to verify Aadhaar' }),
    }),
  }),
  ah(async (req, res) => {
    const consentAt = new Date();
    const decoded = decodeSecureQr(req.body.qrData);
    req.body.qrData = undefined;
    const { name, phone } = req.body;
    const email = req.body.email.toLowerCase();
    if (!namesMatch(name, decoded.name)) {
      throw unprocessable(CODES.INVALID_QR, 'The name on the Aadhaar does not match the name entered', { reason: 'NAME_MISMATCH' });
    }
    await checkAadhaarFree(null, null, decoded); // fail fast before creating an Auth user
    try {
      await auth.getUserByEmail(email);
      throw conflict(CODES.INVALID_STATE, 'An account with this email already exists; ask the guest to sign in');
    } catch (e) {
      if (e.code !== 'auth/user-not-found') throw e;
    }

    const authUser = await auth.createUser({ email, displayName: name, emailVerified: false });
    const ref = db.collection('users').doc(authUser.uid);
    const user = { name, email, phone, role: 'guest', categoryId: 'guest', status: 'active', officialStatus: 'none', createdBy: req.user.uid };
    try {
      await db.runTransaction(async (tx) => {
        const refInfo = await checkAadhaarFree(tx, authUser.uid, decoded);
        const actor = actorFrom(req);
        tx.create(ref, { ...user, aadhaar: null, createdAt: FieldValue.serverTimestamp() });
        writeAudit(tx, actor, { action: 'user.walkin.create', entity: 'user', entityId: authUser.uid, after: user });
        const aadhaar = writeAadhaar(tx, { uid: authUser.uid, decoded, refInfo, actor, consentAt, userExists: false });
        tx.update(ref, { aadhaar });
      });
    } catch (e) {
      await auth.deleteUser(authUser.uid).catch(() => {});
      throw e;
    }
    await syncClaims(authUser.uid, user);
    res.status(201).json({ profile: profileJSON(await ref.get()) });
  }),
);
