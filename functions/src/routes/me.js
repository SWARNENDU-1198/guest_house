import { Router } from 'express';
import { z } from 'zod';
import { db, FieldValue, auth } from '../firebase.js';
import { ah, notFound, conflict, unprocessable, forbidden, CODES } from '../middleware/errors.js';
import { requireRole } from '../middleware/requireRole.js';
import { decodeSecureQr, namesMatch } from '../lib/aadhaarQr.js';
import { checkAadhaarFree, writeAadhaar } from '../lib/verification.js';
import { requireProfile, requireVerifiedLogin, pendingVerification } from '../middleware/auth.js';
import { validate, zPhoneIN } from '../middleware/validate.js';
import { config } from '../config.js';
import { sendEmailOtp, verifyEmailOtp, requireStepUp, PURPOSES } from '../lib/emailOtp.js';
import { aadhaarOtpProvider, isValidAadhaarNumber } from '../lib/aadhaarOtp.js';
import { Timestamp } from '../firebase.js';
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

// Sign-in status for the frontend: what is verified and what is still pending.
const verificationJSON = (user) => ({
  email: user.email,
  emailVerified: user.emailVerified,
  phone: user.phone,
  phoneVerified: Boolean(user.phone),
  loginOtp: user.loginOtp,
  pending: pendingVerification(user),
  policy: { requireEmailVerified: config.requireEmailVerified, requirePhone: config.requirePhone, requireLoginOtp: config.requireLoginOtp, requireStepUp: config.requireStepUp },
});

// GET /auth/status — works before bootstrap and before verification.
router.get('/auth/status', validate(), (req, res) => res.json({ verification: verificationJSON(req.user), bootstrapped: Boolean(req.user.role) }));

// POST /auth/email-otp/send — { purpose: 'verify_email' | 'step_up' }
router.post(
  '/auth/email-otp/send',
  validate({ body: z.strictObject({ purpose: z.enum(PURPOSES) }) }),
  ah(async (req, res) => {
    const { purpose } = req.body;
    if (purpose === 'verify_email' && req.user.emailVerified) throw conflict(CODES.INVALID_STATE, 'Your email is already verified');
    if (purpose === 'step_up' && !req.user.emailVerified && config.requireEmailVerified) throw forbidden('Verify your email address first', CODES.EMAIL_NOT_VERIFIED);
    const name = (await db.collection('users').doc(req.user.uid).get()).data()?.name ?? req.user.tokenName;
    res.json(await sendEmailOtp({ uid: req.user.uid, email: req.user.email, name, purpose }));
  }),
);

// POST /auth/email-otp/verify — { purpose, code }. verify_email: then call getIdToken(true).
router.post(
  '/auth/email-otp/verify',
  validate({ body: z.strictObject({ purpose: z.enum(PURPOSES), code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') }) }),
  ah(async (req, res) => res.json(await verifyEmailOtp({ uid: req.user.uid, ...req.body }))),
);

// POST /auth/bootstrap — idempotent. Creates users/{uid} as guest and sets claims.
router.post(
  '/auth/bootstrap',
  validate({ body: z.strictObject({ name: z.string().trim().min(1).max(100).optional(), phone: zPhoneIN.optional() }) }),
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
        // A phone verified by Firebase SMS OTP wins over a typed one.
        phone: req.user.phone ?? authUser.phoneNumber ?? (config.requirePhone ? null : (req.body.phone ?? null)),
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
    res.status(created ? 201 : 200).json({ profile: profileJSON(snap), verification: verificationJSON(req.user), refreshToken: true });
  }),
);

router.get(
  '/me',
  requireProfile,
  validate(),
  ah(async (req, res) => {
    const ref = db.collection('users').doc(req.user.uid);
    let snap = await ref.get();
    if (!snap.exists) throw notFound('Profile');
    // Keep the profile phone in step with the number verified in Firebase Auth.
    if (req.user.phone && snap.data().phone !== req.user.phone) {
      await ref.update({ phone: req.user.phone });
      snap = await ref.get();
    }
    res.json({ profile: profileJSON(snap), verification: verificationJSON(req.user) });
  }),
);


// PATCH /me — name and phone only (role/category are rejected as unknown fields).
router.patch(
  '/me',
  requireProfile,
  requireVerifiedLogin,
  validate({ body: z.strictObject({ name: z.string().trim().min(1).max(100).optional(), phone: zPhoneIN.optional() }).refine((b) => Object.keys(b).length > 0, 'Nothing to update') }),
  ah(async (req, res) => {
    if (req.body.phone && config.requirePhone) throw unprocessable(CODES.VALIDATION, 'Change your mobile number by verifying the new one with the SMS OTP');
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
  requireVerifiedLogin,
  requireStepUp,
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
  requireVerifiedLogin,
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

// --- Aadhaar OTP (through a licensed KYC provider, see lib/aadhaarOtp.js) ---------
const AADHAAR_OTP_MINUTES = 10;
const AADHAAR_OTP_ATTEMPTS = 3;

// POST /me/aadhaar/otp/send — { aadhaarNumber, consent: true } -> { sessionId }
// UIDAI sends the OTP to the mobile number linked with the Aadhaar.
router.post(
  '/me/aadhaar/otp/send',
  requireProfile,
  requireVerifiedLogin,
  requireStepUp,
  validate({
    body: z.strictObject({
      aadhaarNumber: z.string().transform((s) => s.replace(/[\s-]/g, '')).refine(isValidAadhaarNumber, 'Enter a valid 12-digit Aadhaar number'),
      consent: z.literal(true, { error: 'Consent is required to verify Aadhaar' }),
    }),
  }),
  ah(async (req, res) => {
    const provider = aadhaarOtpProvider();
    const user = (await db.collection('users').doc(req.user.uid).get()).data();
    if (!user) throw notFound('Profile');
    if (user.aadhaar?.verifiedAt) throw conflict(CODES.INVALID_STATE, 'Aadhaar is already verified for this account');
    const last4 = req.body.aadhaarNumber.slice(-4);
    const { providerRef } = await provider.sendOtp(req.body.aadhaarNumber);
    req.body.aadhaarNumber = undefined; // never stored or logged
    const ref = db.collection('aadhaarOtpSessions').doc();
    await ref.set({ uid: req.user.uid, provider: provider.name, providerRef, last4, attempts: 0, consentAt: new Date(), expiresAt: Timestamp.fromMillis(Date.now() + AADHAAR_OTP_MINUTES * 60_000), usedAt: null });
    res.json({ sessionId: ref.id, last4, expiresInSeconds: AADHAAR_OTP_MINUTES * 60 });
  }),
);

// POST /me/aadhaar/otp/verify — { sessionId, otp }
router.post(
  '/me/aadhaar/otp/verify',
  requireProfile,
  requireVerifiedLogin,
  validate({ body: z.strictObject({ sessionId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/), otp: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit OTP') }) }),
  ah(async (req, res) => {
    const sref = db.collection('aadhaarOtpSessions').doc(req.body.sessionId);
    const ssnap = await sref.get();
    const s = ssnap.data();
    if (!s || s.uid !== req.user.uid) throw notFound('Aadhaar OTP session');
    if (s.usedAt || s.expiresAt.toMillis() <= Date.now()) throw unprocessable(CODES.OTP_EXPIRED, 'This OTP has expired. Request a new one.');
    if (s.attempts >= AADHAAR_OTP_ATTEMPTS) throw unprocessable(CODES.OTP_LOCKED, 'Too many wrong attempts. Request a new OTP.');
    const profile = (await db.collection('users').doc(req.user.uid).get()).data();
    const provider = aadhaarOtpProvider();
    if (provider.name !== s.provider) throw unprocessable(CODES.OTP_EXPIRED, 'Request a new OTP');
    let kyc;
    try {
      kyc = await provider.verifyOtp(s.providerRef, req.body.otp, { profileName: profile?.name });
    } catch (e) {
      await sref.update({ attempts: s.attempts + 1 });
      throw e;
    }
    await sref.update({ usedAt: new Date() });
    const decoded = { last4: s.last4, name: kyc.name, dob: kyc.dob, birthYear: kyc.birthYear, gender: kyc.gender, signatureVerified: null };
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
      return writeAadhaar(tx, { uid: req.user.uid, decoded, refInfo, actor: actorFrom(req), consentAt: s.consentAt.toDate(), method: 'otp', provider: s.provider });
    });
    res.json({ verified: true, last4: result.last4, method: 'otp' });
  }),
);
