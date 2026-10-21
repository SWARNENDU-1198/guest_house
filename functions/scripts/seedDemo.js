// Demo data: 2 buildings, 3 room types, 10 rooms, categories + full rate grid,
// a user for every role, a few past stays with receipts, one overdue invoice,
// an upcoming confirmed stay and a waiting queue entry.
// Usage (emulator running): npm run seed:demo
import './target.js';
import { isMain } from './isMain.js';
import { db, auth, FieldValue, Timestamp } from '../src/firebase.js';
import { seedBase, ensureUser } from './seed.js';
import { SYSTEM_ACTOR } from '../src/lib/audit.js';
import { runBookingTx, createBooking } from '../src/lib/booking.js';
import { confirmCashPayment } from '../src/lib/payments.js';
import { nightsBetween, todayIST, addDays } from '../src/lib/dates.js';
import { nightRef } from '../src/lib/nights.js';

const PASSWORD = process.env.SEED_PASSWORD || 'demo1234!';
const T = todayIST();
const D = (n) => addDays(T, n);
const ACTOR = { ...SYSTEM_ACTOR, userAgent: 'seed-demo' };

async function seedCatalog() {
  const batch = db.batch();
  batch.set(db.doc('buildings/main'), { name: 'Main Block', address: 'Campus Road', active: true, createdAt: FieldValue.serverTimestamp() });
  batch.set(db.doc('buildings/annexe'), { name: 'Annexe', address: 'Lake Side', active: true, createdAt: FieldValue.serverTimestamp() });
  const types = { std: ['Standard', 2, ['AC', 'WiFi']], dlx: ['Deluxe', 2, ['AC', 'WiFi', 'TV', 'Kettle']], ste: ['Suite', 4, ['AC', 'WiFi', 'TV', 'Kitchenette', 'Sofa bed']] };
  for (const [id, [name, capacity, amenities]] of Object.entries(types)) batch.set(db.doc(`roomTypes/${id}`), { name, capacity, amenities, active: true, createdAt: FieldValue.serverTimestamp() });
  const rooms = [
    ['101', 'main', 'std', 1], ['102', 'main', 'std', 1], ['103', 'main', 'std', 1], ['104', 'main', 'dlx', 1],
    ['201', 'main', 'dlx', 2], ['202', 'main', 'ste', 2],
    ['A1', 'annexe', 'std', 0], ['A2', 'annexe', 'dlx', 0], ['A3', 'annexe', 'dlx', 0], ['A4', 'annexe', 'ste', 0],
  ];
  for (const [number, buildingId, roomTypeId, floor] of rooms) {
    batch.set(db.doc(`rooms/${buildingId}-${number}`), { number, buildingId, roomTypeId, floor, status: 'available', active: true, createdAt: FieldValue.serverTimestamp() });
  }
  const grid = { guest: [250000, 400000, 700000], faculty: [150000, 250000, 450000], student: [80000, 120000, 300000], staff: [120000, 200000, 400000], official: [0, 0, 0] };
  for (const [cat, amounts] of Object.entries(grid)) {
    ['std', 'dlx', 'ste'].forEach((t, i) => batch.set(db.doc(`rates/${cat}_${t}`), { categoryId: cat, roomTypeId: t, amountPaise: amounts[i], effectiveFrom: FieldValue.serverTimestamp(), updatedBy: 'seed' }));
  }
  await batch.commit();
}

async function pastStay({ userId, roomId, checkIn, checkOut, cash = true }) {
  const b = await runBookingTx((tx) => createBooking(tx, { actor: ACTOR, userId, roomId, checkIn, checkOut, overrides: { advance: true, limits: true }, reason: 'demo seed: past stay', createdBy: 'seed' }));
  if (cash && !b.isFree) await confirmCashPayment({ userId, bookingId: b.id, amountPaise: b.amountPaise, note: 'demo seed', actor: ACTOR, recordedBy: 'seed' });
  await db.doc(`bookings/${b.id}`).update({ state: 'checked_out', checkedInAt: Timestamp.fromDate(new Date(`${checkIn}T06:30:00Z`)), checkedOutAt: Timestamp.fromDate(new Date(`${checkOut}T05:00:00Z`)) });
  for (const d of nightsBetween(checkIn, checkOut)) await nightRef(roomId, d).update({ state: 'occupied' });
  return b;
}

export async function seedDemo() {
  await seedBase();
  await seedCatalog();
  const users = {};
  // Demo mobiles +91 99999 000NN: on the Auth emulator any SMS code works (see the
  // emulator log); on a real project add them as test numbers in the console.
  let n = 0;
  const mk = async (key, email, name, role, categoryId) => {
    n += 1;
    users[key] = await ensureUser({ email, password: PASSWORD, name, role, categoryId, verified: true, phone: `+9199999000${String(n).padStart(2, '0')}` });
  };
  await mk('admin', 'admin@guesthouse.test', 'Asha Admin', 'admin', 'staff');
  await auth.updateUser(users.admin, { password: PASSWORD });
  await mk('frontdesk', 'frontdesk@guesthouse.test', 'Farhan Frontdesk', 'frontdesk', 'staff');
  await mk('accounts', 'accounts@guesthouse.test', 'Anita Accounts', 'accounts', 'staff');
  await mk('guest', 'guest@guesthouse.test', 'Gopal Guest', 'guest', 'guest');
  await mk('guest2', 'guest2@guesthouse.test', 'Geeta Guest', 'guest', 'guest');
  await mk('official', 'official@guesthouse.test', 'Om Official', 'official', 'official');
  await mk('faculty', 'faculty@guesthouse.test', 'Fatima Faculty', 'guest', 'faculty');
  users.newbie = await ensureUser({ email: 'newbie@guesthouse.test', password: PASSWORD, name: 'Neel Newbie', role: 'guest', categoryId: 'guest', verified: false, phone: '+919999900099' });

  await pastStay({ userId: users.guest, roomId: 'main-101', checkIn: D(-20), checkOut: D(-17) });
  await pastStay({ userId: users.guest2, roomId: 'main-201', checkIn: D(-12), checkOut: D(-10) });
  await pastStay({ userId: users.official, roomId: 'annexe-A4', checkIn: D(-8), checkOut: D(-6) });

  // One overdue invoice: a faculty pay-later stay whose 3 reminders went unanswered.
  const fb = await runBookingTx((tx) => createBooking(tx, { actor: ACTOR, userId: users.faculty, roomId: 'main-104', checkIn: D(-15), checkOut: D(-13), payLater: true, overrides: { advance: true }, reason: 'demo seed: overdue invoice', createdBy: 'seed' }));
  await db.doc(`bookings/${fb.id}`).update({ state: 'checked_out' });
  await db.doc(`invoices/${fb.invoiceId}`).update({ status: 'overdue', remindersSent: 3, nextReminderAt: null, issuedAt: Timestamp.fromMillis(Date.now() - 15 * 86_400_000), overdueAt: Timestamp.now() });
  for (let i = 1; i <= 3; i++) {
    await db.collection('reminders').add({ invoiceId: fb.invoiceId, userId: users.faculty, channel: 'email', sentAt: Timestamp.fromMillis(Date.now() - (15 - 3 * i) * 86_400_000), status: 'sent', error: null, sequence: i, manual: false });
  }

  // Upcoming: a confirmed paid stay, and a fully booked suite type with someone waiting.
  const up = await runBookingTx((tx) => createBooking(tx, { actor: ACTOR, userId: users.guest2, roomId: 'annexe-A2', checkIn: D(2), checkOut: D(4), createdBy: 'seed' }));
  await confirmCashPayment({ userId: users.guest2, bookingId: up.id, amountPaise: up.amountPaise, note: 'demo seed', actor: ACTOR, recordedBy: 'seed' });
  await runBookingTx((tx) => createBooking(tx, { actor: ACTOR, userId: users.official, roomId: 'main-202', checkIn: D(5), checkOut: D(6), createdBy: 'seed' }));
  const suite2 = await runBookingTx((tx) => createBooking(tx, { actor: ACTOR, userId: users.admin, roomId: 'annexe-A4', checkIn: D(5), checkOut: D(6), overrides: { limits: true }, reason: 'demo seed: VIP hold', createdBy: 'seed' }));
  await confirmCashPayment({ userId: users.admin, bookingId: suite2.id, amountPaise: suite2.amountPaise, note: 'demo seed', actor: ACTOR, recordedBy: 'seed' });
  const qref = db.collection('queue').doc();
  const qseq = ((await db.doc('counters/queue').get()).data()?.value ?? 0) + 1;
  await db.doc('counters/queue').set({ value: qseq });
  await qref.set({ userId: users.guest, userName: 'Gopal Guest', roomTypeId: 'ste', checkIn: D(5), checkOut: D(6), seq: qseq, requestedAt: FieldValue.serverTimestamp(), state: 'waiting', isOfficial: false, offer: null });

  return { users, password: PASSWORD };
}

if (isMain(import.meta.url)) {
  const { users, password } = await seedDemo();
  console.log('Demo data seeded. Accounts (password for all):', password);
  for (const k of Object.keys(users)) console.log(`  ${k.padEnd(10)} ${k === 'newbie' ? 'newbie@guesthouse.test (not Aadhaar-verified)' : `${k}@guesthouse.test`}`);
  process.exit(0);
}
