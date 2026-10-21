// Points the Admin SDK at the local emulators. Import this before anything
// that touches src/firebase.js.
process.env.GCLOUD_PROJECT ||= 'demo-guesthouse';
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';
process.env.SERVER_SECRET ||= 'test-server-secret-change-me';
process.env.METADATA_SERVER_DETECTION ||= 'none';
process.env.RATE_LIMITS ||= 'off';
// The older suites predate the sign-in policy; v10 switches it back on.
process.env.AUTH_REQUIRE_EMAIL_VERIFIED ||= 'false';
process.env.AUTH_REQUIRE_PHONE ||= 'false';
process.env.AUTH_REQUIRE_LOGIN_OTP ||= 'false';
process.env.AUTH_REQUIRE_STEP_UP ||= 'false';
