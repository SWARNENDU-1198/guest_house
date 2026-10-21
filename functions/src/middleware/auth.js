import { auth } from '../firebase.js';
import { unauthenticated, forbidden, CODES } from './errors.js';

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
