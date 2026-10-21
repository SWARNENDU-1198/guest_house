import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp, FieldPath } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { config } from './config.js';

const app = getApps()[0] ?? initializeApp({ projectId: config.projectId });

export const db = getFirestore(app);
if (!globalThis.__firestoreConfigured) {
  db.settings({ ignoreUndefinedProperties: true });
  globalThis.__firestoreConfigured = true;
}
export const auth = getAuth(app);
export { FieldValue, Timestamp, FieldPath };
