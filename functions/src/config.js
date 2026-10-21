// Environment-driven configuration. Values are read lazily so tests and the
// emulator can set process.env before the first request.

const env = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
};

export const VERSION = '1.1.0';

export const ROLES = ['guest', 'official', 'frontdesk', 'accounts', 'admin'];
export const STAFF_ROLES = ['frontdesk', 'accounts', 'admin'];

export const config = {
  get projectId() {
    return env('GCLOUD_PROJECT', env('FIREBASE_PROJECT_ID', 'demo-guesthouse'));
  },
  get corsOrigins() {
    return env('CORS_ORIGINS', 'http://localhost:5173,http://localhost:3000')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  },
  get serverSecret() {
    const s = env('SERVER_SECRET');
    if (!s) throw new Error('SERVER_SECRET is not set');
    return s;
  },
  // Sign-in policy (see docs/AUTH.md). Each defaults to on; set 'false' to relax.
  get requireEmailVerified() {
    return env('AUTH_REQUIRE_EMAIL_VERIFIED', 'true') !== 'false';
  },
  get requirePhone() {
    return env('AUTH_REQUIRE_PHONE', 'true') !== 'false';
  },
  // Every session must come from an SMS OTP (phone sign-in or SMS second factor).
  // Off by default on the emulator so password-only demo logins keep working.
  get requireLoginOtp() {
    return env('AUTH_REQUIRE_LOGIN_OTP', this.isEmulator ? 'false' : 'true') !== 'false';
  },
  // Email OTP before sensitive actions (Aadhaar, cancellations, refunds, role changes).
  get requireStepUp() {
    return env('AUTH_REQUIRE_STEP_UP', 'true') !== 'false';
  },
  get isEmulator() {
    return Boolean(process.env.FIRESTORE_EMULATOR_HOST || process.env.FUNCTIONS_EMULATOR);
  },
};
