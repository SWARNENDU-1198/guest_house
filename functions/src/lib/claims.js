import { auth } from '../firebase.js';

// Custom claims mirror users/{uid}: role, categoryId, suspended.
export async function syncClaims(uid, user, { revoke = false } = {}) {
  await auth.setCustomUserClaims(uid, {
    role: user.role,
    categoryId: user.categoryId ?? null,
    suspended: user.status === 'suspended',
  });
  // Revoking makes the change apply at once: old ID tokens fail with TOKEN_REVOKED.
  if (revoke) await auth.revokeRefreshTokens(uid);
}
