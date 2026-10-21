import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp, FieldPath, AggregateField } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { config } from './config.js';

// Credentials: Cloud Functions and the emulator need nothing. On a plain Node host
// (Render, Railway, a VM) either point GOOGLE_APPLICATION_CREDENTIALS at the
// service-account file, or put the file's JSON (raw or base64) in
// FIREBASE_SERVICE_ACCOUNT, which suits hosts that only take env variables.
function serviceAccountFromEnv() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  const sa = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
  // The project id comes from the key file unless GCLOUD_PROJECT says otherwise.
  process.env.GCLOUD_PROJECT ||= sa.project_id;
  return { ...sa, private_key: sa.private_key?.replace(/\\n/g, '\n') };
}

const sa = getApps().length ? null : serviceAccountFromEnv();
const app = getApps()[0] ?? initializeApp({ projectId: config.projectId, ...(sa ? { credential: cert(sa) } : {}) });

export const db = getFirestore(app);
if (!globalThis.__firestoreConfigured) {
  db.settings({ ignoreUndefinedProperties: true });
  globalThis.__firestoreConfigured = true;
}
export const auth = getAuth(app);
export { FieldValue, Timestamp, FieldPath, AggregateField };
