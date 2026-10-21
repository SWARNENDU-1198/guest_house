// Scripts default to the local emulators; pass --prod to target a real project
// (then credentials come from GOOGLE_APPLICATION_CREDENTIALS).
if (!process.argv.includes('--prod')) {
  process.env.GCLOUD_PROJECT ||= 'demo-guesthouse';
  process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';
}
