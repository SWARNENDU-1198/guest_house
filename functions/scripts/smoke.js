// End-to-end demo script over real HTTP against a running API (default: the
// Functions emulator). Run after `npm run seed:demo` on a fresh emulator:
//   npm run smoke                       # waits ~65s for the live reminder
//   npm run smoke -- --base http://localhost:8080/api/v1
//
// book → pay (test mode) → receipt; cancel → queue offer; invoice → reminder;
// admin rate change → audit entry; every dashboard loads.
import './target.js';
import { auth, db } from '../src/firebase.js';
import { mockGateway } from '../src/lib/razorpay.js';
import { todayIST, addDays } from '../src/lib/dates.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const BASE = arg('base', process.env.API_BASE || `http://127.0.0.1:5001/${process.env.GCLOUD_PROJECT}/asia-south1/api/v1`);
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const PASSWORD = process.env.SEED_PASSWORD || 'demo1234!';
const D = (n) => addDays(todayIST(), n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name} (${Date.now() - t0} ms)${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name} — ${e.message}`);
  }
}
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const idt = (path) => `http://${AUTH}/identitytoolkit.googleapis.com/v1/${path}?key=fake-api-key`;
const postJSON = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

// The production sign-in: Firebase SMS OTP to the account's +91 mobile. The Auth
// emulator does not send SMS; it exposes the codes at /emulator/v1/.../verificationCodes.
async function signIn(email) {
  const { phoneNumber, uid } = await auth.getUserByEmail(email);
  if (!phoneNumber) {
    const j = await postJSON(idt('accounts:signInWithPassword'), { email, password: PASSWORD, returnSecureToken: true });
    if (!j.idToken) throw new Error(`sign-in failed for ${email}`);
    return { token: j.idToken, uid };
  }
  const { sessionInfo } = await postJSON(idt('accounts:sendVerificationCode'), { phoneNumber, recaptchaToken: 'emulator' });
  const codes = await fetch(`http://${AUTH}/emulator/v1/projects/${process.env.GCLOUD_PROJECT}/verificationCodes`).then((r) => r.json());
  const { code } = codes.verificationCodes.filter((c) => c.sessionInfo === sessionInfo).pop();
  const j = await postJSON(idt('accounts:signInWithPhoneNumber'), { sessionInfo, code });
  if (!j.idToken) throw new Error(`SMS sign-in failed for ${email}`);
  return { token: j.idToken, uid };
}

// Email OTP step-up before cancellations, refunds and role changes. On a demo-*
// emulator project the code is readable from otps/{uid}_step_up.emulatorCode.
async function stepUp(c) {
  const s = await c.post('/auth/email-otp/send', { purpose: 'step_up' });
  if (s.status === 429) return; // a code was sent moments ago and is still valid
  if (s.status !== 200) throw new Error(`step-up send ${s.status} ${JSON.stringify(s.data)}`);
  const code = (await db.collection('otps').doc(`${c.uid}_step_up`).get()).data()?.emulatorCode;
  const v = await c.post('/auth/email-otp/verify', { purpose: 'step_up', code });
  if (v.status !== 200) throw new Error(`step-up verify ${v.status} ${JSON.stringify(v.data)}`);
}

function client({ token, uid }) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const type = r.headers.get('content-type') ?? '';
    const data = type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
    return { status: r.status, data, type };
  };
  return { uid, get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b) };
}

const who = {};
await step('health', async () => {
  const r = await fetch(`${BASE}/health`);
  const j = await r.json();
  expect(j.ok, 'health not ok');
  return `version ${j.version}`;
});
await step('sign in demo accounts with SMS OTP (Auth emulator)', async () => {
  for (const k of ['admin', 'frontdesk', 'accounts', 'guest', 'guest2', 'official']) who[k] = client(await signIn(`${k}@guesthouse.test`));
});

let booking;
let receiptId;
await step('book: guest holds a Standard room by type', async () => {
  const r = await who.guest.post('/bookings/by-type', { roomTypeId: 'std', checkIn: D(10), checkOut: D(12) });
  expect(r.status === 201, `status ${r.status} ${JSON.stringify(r.data)}`);
  booking = r.data.booking;
  expect(booking.state === 'held', 'not held');
  return `${booking.code} room ${booking.roomNumber}, Rs. ${booking.amountPaise / 100}, hold until ${booking.holdExpiresAt}`;
});
await step('pay (Razorpay test mode / mock): order → checkout → verify', async () => {
  const o = await who.guest.post('/payments/order', { bookingId: booking.id });
  expect(o.status === 201, `order ${o.status}`);
  expect(o.data.amount === booking.amountPaise, 'amount differs from snapshot');
  const { payment, signature } = mockGateway.pay(o.data.orderId);
  const v = await who.guest.post('/payments/verify', { razorpay_order_id: o.data.orderId, razorpay_payment_id: payment.id, razorpay_signature: signature });
  expect(v.status === 200 && v.data.booking.state === 'confirmed', `verify ${v.status} ${JSON.stringify(v.data)}`);
  receiptId = v.data.receipt.id;
  return `confirmed, receipt ${v.data.receipt.number}`;
});
await step('receipt PDF downloads', async () => {
  const r = await who.guest.get(`/receipts/${receiptId}/pdf`);
  expect(r.status === 200 && r.type.includes('pdf') && r.data.subarray(0, 4).toString() === '%PDF', 'not a PDF');
  return `${r.data.length} bytes`;
});

await step('cancel → queue offer: the waiting guest gets the freed suite', async () => {
  const mine = await who.official.get('/bookings/me');
  const b = mine.data.items.find((x) => x.roomId === 'main-202' && x.state === 'confirmed');
  expect(b, 'seeded official suite booking not found');
  await stepUp(who.official);
  const c = await who.official.post(`/bookings/${b.id}/cancel`, { reason: 'meeting moved' });
  expect(c.status === 200 && c.data.offeredToQueue, `cancel ${c.status} ${JSON.stringify(c.data)}`);
  const q = await who.guest.get('/queue/me');
  const entry = q.data.items.find((e) => e.roomTypeId === 'ste');
  expect(entry?.state === 'offered', `queue entry is ${entry?.state}`);
  const av = await who.guest2.get(`/availability?checkIn=${D(5)}&checkOut=${D(6)}&roomTypeId=ste`);
  expect(av.data.rooms.length === 0, 'freed suite visible to others while offered');
  return `offer on room ${entry.offer.roomNumber} until ${entry.offer.expiresAt}`;
});

await step('invoice → reminder fires live (reminderUnit = minutes)', async () => {
  await who.admin.patch('/settings', { reminderUnit: 'minutes', reminderAfterDays: 1 });
  const g2 = await who.guest2.get('/bookings/me');
  const b = g2.data.items.find((x) => x.state === 'confirmed');
  const ch = await who.frontdesk.post(`/frontdesk/bookings/${b.id}/charges`, { lines: [{ label: 'Airport pickup', amountPaise: 80000 }] });
  expect([200, 201].includes(ch.status), `charges ${ch.status} ${JSON.stringify(ch.data)}`);
  const id = ch.data.invoice.id;
  const fast = process.argv.includes('--fast');
  if (!fast) {
    console.log('      waiting 65s for the first reminder to fall due…');
    await sleep(65_000);
    const run = await who.admin.post('/admin/jobs/sendReminders/run');
    expect(run.data.result.reminded >= 1, `job reminded ${JSON.stringify(run.data)}`);
  } else {
    await who.accounts.post(`/admin/invoices/${id}/remind`);
  }
  const inv = await who.guest2.get(`/invoices/${id}`);
  expect(inv.data.reminders.length >= 1, 'no reminder in history');
  await who.admin.patch('/settings', { reminderUnit: 'days', reminderAfterDays: 3 });
  return `${inv.data.invoice.number}: ${inv.data.reminders.length} reminder(s) in history`;
});

await step('admin rate change → audit entry with before/after', async () => {
  const before = (await who.admin.get('/rates')).data.items.find((r) => r.categoryId === 'guest' && r.roomTypeId === 'std').amountPaise;
  const r = await who.admin.put('/rates/guest/std', { amountPaise: before + 10000 });
  expect(r.status === 200, `rate ${r.status}`);
  const a = await who.admin.get('/admin/audit/rate/guest_std');
  const last = a.data.items[a.data.items.length - 1];
  expect(last.action === 'rate.update' && last.before.amountPaise === before && last.after.amountPaise === before + 10000, 'audit entry missing');
  await who.admin.put('/rates/guest/std', { amountPaise: before });
  return `Rs. ${before / 100} → Rs. ${(before + 10000) / 100} audited`;
});

await step('every dashboard loads in one call (< 1 s)', async () => {
  const times = [];
  for (const [c, p] of [[who.guest, '/dashboard/me'], [who.frontdesk, '/dashboard/frontdesk'], [who.accounts, '/dashboard/accounts'], [who.admin, '/dashboard/admin']]) {
    const t0 = Date.now();
    const r = await c.get(p);
    const ms = Date.now() - t0;
    expect(r.status === 200, `${p} ${r.status}`);
    expect(ms < 1000, `${p} took ${ms} ms`);
    times.push(`${p.split('/')[2]} ${ms}ms`);
  }
  return times.join(', ');
});

await step('security spot checks: no token 401, wrong role 403, forged webhook 400', async () => {
  expect((await fetch(`${BASE}/me`)).status === 401, 'no token');
  expect((await who.guest.get('/dashboard/admin')).status === 403, 'guest on admin');
  const w = await fetch(`${BASE}/webhooks/razorpay`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': 'bad' }, body: '{"event":"payment.captured"}' });
  expect(w.status === 400, `webhook ${w.status}`);
});

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} steps passed`);
process.exit(failed ? 1 : 0);
