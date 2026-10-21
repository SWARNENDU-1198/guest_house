import { auth } from '../firebase.js';
import { config } from '../config.js';
import { unauthenticated, forbidden, CODES } from './errors.js';

const INDIAN_MOBILE = /^\+91[6-9]\d{9}$/;

// Verifies the Firebase ID token (including revocation) and sets req.user.
export async function authenticate(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) throw unauthenticated('Missing Authorization: Bearer <ID token>');
    let decoded;
    try {
      decoded = await auth.verifyIdToken(match[1], true);
    } catch (e) {
      if (e?.code === 'auth/id-token-revoked') {
        throw unauthenticated('Your session changed (e.g. a role update). Sign in again.', CODES.TOKEN_REVOKED);
      }
      if (e?.code === 'auth/user-disabled') throw forbidden('Account disabled', CODES.SUSPENDED);
      throw unauthenticated('Invalid or expired ID token');
    }
    req.user = {
      uid: decoded.uid,
      email: decoded.email ?? null,
      emailVerified: decoded.email_verified === true,
      phone: decoded.phone_number ?? null,
      // 'phone' when this session was opened with an SMS OTP, either as the sign-in
      // method or as the second factor after email + password.
      loginOtp: decoded.firebase?.sign_in_provider === 'phone' || decoded.firebase?.sign_in_second_factor === 'phone',
      role: decoded.role ?? null,
      categoryId: decoded.categoryId ?? null,
      suspended: decoded.suspended === true,
      tokenName: decoded.name ?? null,
    };
    next();
  } catch (e) {
    next(e);
  }
}

// Every route except /auth/bootstrap needs a bootstrapped, active profile.
export function requireProfile(req, res, next) {
  if (!req.user?.role) {
    return next(forbidden('Call POST /auth/bootstrap after first sign-in', CODES.NOT_BOOTSTRAPPED));
  }
  if (req.user.suspended) return next(forbidden('Your account is suspended', CODES.SUSPENDED));
  next();
}

// What the account still has to do before it may use the app (empty = nothing).
export function pendingVerification(user) {
  const pending = [];
  if (config.requireEmailVerified && (!user.email || !user.emailVerified)) pending.push('email');
  if (config.requirePhone && !INDIAN_MOBILE.test(user.phone ?? '')) pending.push('phone');
  if (config.requireLoginOtp && !user.loginOtp) pending.push('loginOtp');
  return pending;
}

// Verified email (email OTP or Firebase link), verified Indian mobile (Firebase
// SMS OTP) and, in production, a session that was opened with an SMS OTP.
export function requireVerifiedLogin(req, res, next) {
  const [first] = pendingVerification(req.user);
  if (first === 'email') return next(forbidden('Verify your email address first (POST /auth/email-otp/send)', CODES.EMAIL_NOT_VERIFIED));
  if (first === 'phone') return next(forbidden('Verify an Indian mobile number (+91) with the SMS OTP first', CODES.PHONE_NOT_VERIFIED));
  if (first === 'loginOtp') return next(forbidden('Sign in again and complete the SMS OTP step', CODES.LOGIN_OTP_REQUIRED));
  next();
}
