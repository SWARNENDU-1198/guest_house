import { Router } from 'express';
import { z } from 'zod';
import { db, FieldValue, auth } from '../firebase.js';
import { ah, notFound, conflict, unprocessable, CODES } from '../middleware/errors.js';
import { requireRole } from '../middleware/requireRole.js';
import { decodeSecureQr, namesMatch } from '../lib/aadhaarQr.js';
import { checkAadhaarFree, writeAadhaar } from '../lib/verification.js';
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

const zPhone = z.string().trim().regex(/^\+?\d{10,13}$/, 'Invalid phone number');

// PATCH /me — name and phone only (role/category are rejected as unknown fields).
router.patch(
  '/me',
  requireProfile,
  validate({ body: z.strictObject({ name: z.string().trim().min(1).max(100).optional(), phone: zPhone.optional() }).refine((b) => Object.keys(b).length > 0, 'Nothing to update') }),
  ah(async (req, res) => {
    const ref = db.collection('users').doc(req.user.uid);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound('Profile');
      const before = snap.data();
      tx.update(ref, req.body);
      writeAudit(tx, actorFrom(req), {
        action: 'user.profile.update',
        entity: 'user',
        entityId: req.user.uid,
        before: Object.fromEntries(Object.keys(req.body).map((k) => [k, before[k] ?? null])),
        after: req.body,
      });
    });
    res.json({ profile: profileJSON(await ref.get()) });
  }),
);

// POST /me/aadhaar/verify-qr — { qrData, consent: true }
router.post(
  '/me/aadhaar/verify-qr',
  requireProfile,
  validate({
    body: z.strictObject({
      qrData: z.string().min(1).max(12000),
      consent: z.literal(true, { error: 'Consent is required to verify Aadhaar' }),
    }),
  }),
  ah(async (req, res) => {
    const consentAt = new Date();
    const decoded = decodeSecureQr(req.body.qrData);
    req.body.qrData = undefined; // drop the raw payload as early as possible
    const ref = db.collection('users').doc(req.user.uid);
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound('Profile');
      const user = snap.data();
      if (user.aadhaar?.verifiedAt) throw conflict(CODES.INVALID_STATE, 'Aadhaar is already verified for this account');
      if (!namesMatch(user.name, decoded.name)) {
        throw unprocessable(CODES.INVALID_QR, 'The name on the Aadhaar does not match your profile name', { reason: 'NAME_MISMATCH' });
      }
      const refInfo = await checkAadhaarFree(tx, req.user.uid, decoded);
      return writeAadhaar(tx, { uid: req.user.uid, decoded, refInfo, actor: actorFrom(req), consentAt });
    });
    res.json({ verified: true, last4: result.last4, signatureVerified: result.signatureVerified });
  }),
);

// POST /me/official-request — guests ask to become officials.
router.post(
  '/me/official-request',
  requireProfile,
  requireRole('guest'),
  validate({
    body: z.strictObject({
      department: z.string().trim().min(2).max(120),
      designation: z.string().trim().min(2).max(120),
      officialEmail: z.email().max(200),
      idProofNote: z.string().trim().max(500).optional(),
    }),
  }),
  ah(async (req, res) => {
    const userRef = db.collection('users').doc(req.user.uid);
    const reqRef = db.collection('officialRequests').doc();
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw notFound('Profile');
      if (snap.data().officialStatus === 'pending') throw conflict(CODES.INVALID_STATE, 'You already have a pending request');
      const doc = {
        uid: req.user.uid,
        name: snap.data().name,
        department: req.body.department,
        designation: req.body.designation,
        officialEmail: req.body.officialEmail,
        idProofNote: req.body.idProofNote ?? null,
        status: 'pending',
        createdAt: FieldValue.serverTimestamp(),
        decidedBy: null,
        decidedAt: null,
        reason: null,
      };
      tx.create(reqRef, doc);
      tx.update(userRef, { officialStatus: 'pending' });
      writeAudit(tx, actorFrom(req), { action: 'official.request', entity: 'officialRequest', entityId: reqRef.id, after: doc });
    });
    res.status(201).json({ request: docJSON(await reqRef.get()) });
  }),
);
