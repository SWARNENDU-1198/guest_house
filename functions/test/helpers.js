import './env.js';
import request from 'supertest';
import { app } from '../src/app.js';
import { db, auth, FieldValue } from '../src/firebase.js';
import { seedBase, CATEGORIES } from '../scripts/seed.js';

process.env.LOG_SILENT = 'true';

const PROJECT = process.env.GCLOUD_PROJECT;
const FS = process.env.FIRESTORE_EMULATOR_HOST;
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST;

export { app, db, auth, FieldValue, CATEGORIES };
export const api = () => request(app);
export const V = '/api/v1';

export async function resetEmulators() {
  await fetch(`http://${FS}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`http://${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
}

export async function signIn(email, password = 'pass1234!') {
  const r = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const j = await r.json();
  if (!j.idToken) throw new Error(`signIn failed: ${JSON.stringify(j)}`);
  return j.idToken;
}

let counter = 0;
// Creates an Auth user (+ profile + claims unless bootstrap:false) and returns a token.
export async function makeUser({ role = 'guest', categoryId, verified = true, profile = true, name, email, status = 'active', extra = {} } = {}) {
  counter += 1;
  email ??= `${role}${counter}-${Date.now()}@test.local`;
  name ??= `Test ${role} ${counter}`;
  categoryId ??= role === 'official' ? 'official' : role === 'guest' ? 'guest' : 'staff';
  const user = await auth.createUser({ email, password: 'pass1234!', displayName: name });
  if (profile) {
    await db.collection('users').doc(user.uid).set({
      name,
      email,
      phone: null,
      role,
      categoryId,
      status,
      officialStatus: role === 'official' ? 'approved' : 'none',
      aadhaar: verified ? { last4: '1234', verifiedName: name, birthYear: 1990, method: 'test', verifiedAt: FieldValue.serverTimestamp() } : null,
      createdAt: FieldValue.serverTimestamp(),
      ...extra,
    });
    await auth.setCustomUserClaims(user.uid, { role, categoryId, suspended: status === 'suspended' });
  }
  const token = await signIn(email);
  return { uid: user.uid, email, name, token, auth: { Authorization: `Bearer ${token}` } };
}

export async function freshWorld() {
  await resetEmulators();
  await seedBase();
}

export async function auditFor(entity, entityId) {
  const snap = await db.collection('auditLogs').where('entity', '==', entity).where('entityId', '==', entityId).get();
  return snap.docs.map((d) => d.data());
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
