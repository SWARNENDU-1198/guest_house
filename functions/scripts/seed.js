// Seeds the base data: one Admin account, the categories and settings/global.
// Usage (emulator):  npm run seed
// Refuses to touch a real project unless --prod is passed.
import './target.js';
import { db, auth, FieldValue } from '../src/firebase.js';
import { DEFAULT_SETTINGS } from '../src/lib/settings.js';

if (!process.env.FIRESTORE_EMULATOR_HOST && !process.argv.includes('--prod')) {
  console.error('FIRESTORE_EMULATOR_HOST is not set. Pass --prod to seed a real project.');
  process.exit(1);
}

export const CATEGORIES = {
  guest: { name: 'General guest', isFree: false, maxNights: 7, maxAdvanceDays: 60, payLaterAllowed: false, active: true },
  official: { name: 'Official', isFree: true, maxNights: 5, maxAdvanceDays: 30, payLaterAllowed: false, active: true },
  faculty: { name: 'Faculty', isFree: false, maxNights: 10, maxAdvanceDays: 90, payLaterAllowed: true, active: true },
  student: { name: 'Student', isFree: false, maxNights: 3, maxAdvanceDays: 30, payLaterAllowed: false, active: true },
  staff: { name: 'Staff', isFree: false, maxNights: 7, maxAdvanceDays: 60, payLaterAllowed: true, active: true },
};

export async function ensureUser({ email, password, name, role, categoryId = 'guest', verified = false, phone = null }) {
  let user;
  try {
    user = await auth.getUserByEmail(email);
  } catch {
    user = await auth.createUser({ email, password, displayName: name, emailVerified: true });
  }
  const doc = {
    name,
    email,
    phone,
    role,
    categoryId,
    status: 'active',
    officialStatus: role === 'official' ? 'approved' : 'none',
    aadhaar: verified
      ? { last4: String(1000 + Math.floor(Math.random() * 9000)), verifiedName: name, birthYear: 1990, method: 'seed', verifiedAt: FieldValue.serverTimestamp(), signatureVerified: false }
      : null,
    createdAt: FieldValue.serverTimestamp(),
  };
  await db.collection('users').doc(user.uid).set(doc);
  await auth.setCustomUserClaims(user.uid, { role, categoryId, suspended: false });
  return user.uid;
}

export async function seedBase() {
  const batch = db.batch();
  for (const [id, c] of Object.entries(CATEGORIES)) batch.set(db.collection('categories').doc(id), c);
  batch.set(db.collection('settings').doc('global'), DEFAULT_SETTINGS);
  await batch.commit();
  const adminUid = await ensureUser({
    email: process.env.SEED_ADMIN_EMAIL || 'admin@guesthouse.test',
    password: process.env.SEED_ADMIN_PASSWORD || 'admin123!',
    name: 'Admin',
    role: 'admin',
    categoryId: 'staff',
    verified: true,
  });
  return { adminUid };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await seedBase();
  console.log('Seeded categories, settings/global and admin', r);
  process.exit(0);
}
