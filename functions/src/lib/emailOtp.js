// 6-digit email OTPs. Two purposes:
//   verify_email  marks the Firebase account's email as verified
//   step_up       unlocks sensitive actions for STEP_UP_MINUTES (Aadhaar,
//                 cancellations, refunds, role changes)
// Only an HMAC of the code is stored (otps/{uid}_{purpose}, backend-only).
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { db, auth, Timestamp } from '../firebase.js';
import { config } from '../config.js';
import { ApiError, forbidden, CODES } from '../middleware/errors.js';
import { getSettings } from './settings.js';
import { sendMail } from './mailer.js';
import { emailOtp as template } from './emails.js';
import { log } from './log.js';

export const PURPOSES = ['verify_email', 'step_up'];
export const OTP_MINUTES = 10;
export const STEP_UP_MINUTES = 10;
const RESEND_SECONDS = 60;
const MAX_SENDS_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

const otpRef = (uid, purpose) => db.collection('otps').doc(`${uid}_${purpose}`);
const hash = (uid, purpose, code) => createHmac('sha256', config.serverSecret).update(`${uid}|${purpose}|${code}`).digest();
const tooMany = (code, message, details) => new ApiError(429, code, message, details);
// Like the Auth emulator's SMS codes: on a local demo-* project the code is also
// kept in clear (otps doc field emulatorCode) so scripts and testers can read it.
// Never on a real project.
const exposeCode = () => config.isEmulator && config.projectId.startsWith('demo-');

export async function sendEmailOtp({ uid, email, name, purpose }) {
  if (!email) throw forbidden('This account has no email address', CODES.EMAIL_NOT_VERIFIED);
  const ref = otpRef(uid, purpose);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = snap.data();
    const lastSent = d?.sentAt?.toMillis() ?? 0;
    if (now - lastSent < RESEND_SECONDS * 1000) {
      const wait = Math.ceil((RESEND_SECONDS * 1000 - (now - lastSent)) / 1000);
      throw tooMany(CODES.OTP_COOLDOWN, `Please wait ${wait} seconds before requesting another code`, { retryAfterSeconds: wait });
    }
    const windowStart = d?.windowStart?.toMillis() ?? 0;
    const inWindow = now - windowStart < 3_600_000;
    const sends = inWindow ? (d?.sends ?? 0) : 0;
    if (sends >= MAX_SENDS_PER_HOUR) throw tooMany(CODES.OTP_COOLDOWN, 'Too many codes requested. Try again in an hour.', { retryAfterSeconds: Math.ceil((windowStart + 3_600_000 - now) / 1000) });
    tx.set(ref, {
      uid,
      purpose,
      codeHash: hash(uid, purpose, code).toString('hex'),
      expiresAt: Timestamp.fromMillis(now + OTP_MINUTES * 60_000),
      attempts: 0,
      sentAt: Timestamp.fromMillis(now),
      windowStart: Timestamp.fromMillis(inWindow ? windowStart : now),
      sends: sends + 1,
      stepUpUntil: d?.stepUpUntil ?? null,
      ...(exposeCode() ? { emulatorCode: code } : {}),
    });
  });
  const org = (await getSettings()).organisation;
  const sent = await sendMail({ to: email, tag: `otp.${purpose}`, ...template(org, { name, code, purpose, minutes: OTP_MINUTES }) });
  if (!sent.ok) {
    log.error('otp.mail.failed', { purpose });
    throw new ApiError(502, CODES.PROVIDER_ERROR, 'Could not send the email. Try again shortly.');
  }
  return { expiresInSeconds: OTP_MINUTES * 60, resendAfterSeconds: RESEND_SECONDS };
}

export async function verifyEmailOtp({ uid, purpose, code }) {
  const ref = otpRef(uid, purpose);
  const now = Date.now();
  const outcome = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = snap.data();
    if (!d?.codeHash || d.expiresAt.toMillis() <= now) return { error: 'expired' };
    if (d.attempts >= MAX_ATTEMPTS) return { error: 'locked' };
    const ok = timingSafeEqual(Buffer.from(d.codeHash, 'hex'), hash(uid, purpose, code));
    if (!ok) {
      tx.update(ref, { attempts: d.attempts + 1 });
      return { error: 'invalid', attemptsLeft: MAX_ATTEMPTS - d.attempts - 1 };
    }
    const stepUpUntil = purpose === 'step_up' ? Timestamp.fromMillis(now + STEP_UP_MINUTES * 60_000) : (d.stepUpUntil ?? null);
    tx.update(ref, { codeHash: null, emulatorCode: null, expiresAt: Timestamp.fromMillis(now), verifiedAt: Timestamp.fromMillis(now), stepUpUntil });
    return { ok: true, stepUpUntil };
  });
  // Errors are thrown after the transaction so a wrong guess still counts.
  if (outcome.error === 'expired') throw new ApiError(422, CODES.OTP_EXPIRED, 'This code has expired. Request a new one.');
  if (outcome.error === 'locked') throw tooMany(CODES.OTP_LOCKED, 'Too many wrong attempts. Request a new code.');
  if (outcome.error === 'invalid') throw new ApiError(422, CODES.OTP_INVALID, 'That code is not correct', { attemptsLeft: outcome.attemptsLeft });
  if (purpose === 'verify_email') await auth.updateUser(uid, { emailVerified: true });
  return { verified: true, stepUpUntil: outcome.stepUpUntil?.toDate().toISOString() ?? null, refreshToken: purpose === 'verify_email' };
}

// Middleware: a recent step_up OTP is needed (off when AUTH_REQUIRE_STEP_UP=false).
// Staff acting on someone else's behalf need it too.
export function requireStepUp(req, res, next) {
  if (!config.requireStepUp) return next();
  otpRef(req.user.uid, 'step_up')
    .get()
    .then((snap) => {
      const until = snap.data()?.stepUpUntil?.toMillis() ?? 0;
      if (until > Date.now()) return next();
      next(forbidden('Confirm with the code we email you (POST /auth/email-otp/send { purpose: "step_up" })', CODES.STEP_UP_REQUIRED));
    })
    .catch(next);
}
