import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, V, freshWorld, makeUser, signIn, db, auth } from './helpers.js';
import { buildHouse } from './fixtures.js';
import { todayIST, addDays, fyIST } from '../src/lib/dates.js';
import { outbox } from '../src/lib/mailer.js';
import { inr, amountInWords, dateIN, dateTimeIN, phoneIN, numberToWordsIN } from '../src/lib/format.js';
import { isValidAadhaarNumber } from '../src/lib/aadhaarOtp.js';

const D = (n) => addDays(todayIST(), n);
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const PROJECT = process.env.GCLOUD_PROJECT;
const idt = (path) => `http://${AUTH}/identitytoolkit.googleapis.com/v1/${path}?key=fake-api-key`;
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

// The real Firebase phone flow, against the Auth emulator: send code -> read it -> sign in.
async function smsSignIn(phoneNumber) {
  const { sessionInfo } = await post(idt('accounts:sendVerificationCode'), { phoneNumber, recaptchaToken: 'emulator' });
  const codes = await fetch(`http://${AUTH}/emulator/v1/projects/${PROJECT}/verificationCodes`).then((r) => r.json());
  const { code } = codes.verificationCodes.filter((c) => c.sessionInfo === sessionInfo).pop();
  const j = await post(idt('accounts:signInWithPhoneNumber'), { sessionInfo, code });
  if (!j.idToken) throw new Error(JSON.stringify(j));
  return j.idToken;
}

const POLICY = ['AUTH_REQUIRE_EMAIL_VERIFIED', 'AUTH_REQUIRE_PHONE', 'AUTH_REQUIRE_LOGIN_OTP', 'AUTH_REQUIRE_STEP_UP'];
function withPolicy(values) {
  const saved = {};
  before(() => {
    for (const k of POLICY) {
      saved[k] = process.env[k];
      process.env[k] = values[k] ?? 'false';
    }
  });
  after(() => {
    for (const k of POLICY) process.env[k] = saved[k];
  });
}

// Marks the email verified and adds a +91 mobile, then signs in again.
async function verifiedUser(opts = {}, phone) {
  const u = await makeUser(opts);
  await auth.updateUser(u.uid, { emailVerified: true, phoneNumber: phone ?? `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` });
  const token = await signIn(u.email);
  return { ...u, token, auth: { Authorization: `Bearer ${token}` } };
}

const lastCode = (to) => {
  const m = [...outbox].reverse().find((x) => x.to === to && x.tag?.startsWith('otp.'));
  return m?.text.match(/\b(\d{6})\b/)?.[1];
};

describe('v1.1 Indian formats', () => {
  it('rupees, lakh/crore grouping and amount in words', () => {
    assert.equal(inr(12345678), '₹1,23,456.78');
    assert.equal(inr(1_000_000_000), '₹1,00,00,000.00');
    assert.equal(amountInWords(250000), 'Rupees Two Thousand Five Hundred Only');
    assert.equal(amountInWords(12345678), 'Rupees One Lakh Twenty-Three Thousand Four Hundred Fifty-Six and Seventy-Eight Paise Only');
    assert.equal(numberToWordsIN(12_34_56_789), 'Twelve Crore Thirty-Four Lakh Fifty-Six Thousand Seven Hundred Eighty-Nine');
  });

  it('DD/MM/YYYY dates, IST times, +91 phones, financial year', () => {
    assert.equal(dateIN('2026-10-21'), '21/10/2026');
    assert.equal(dateTimeIN('2026-10-21T09:00:00Z'), '21/10/2026, 02:30 PM IST');
    assert.equal(dateTimeIN('2026-10-21T18:45:00Z'), '22/10/2026, 12:15 AM IST');
    assert.equal(phoneIN('+919876543210'), '+91 98765 43210');
    assert.equal(fyIST(Date.parse('2026-03-31T18:00:00Z')), '25-26');
    assert.equal(fyIST(Date.parse('2026-03-31T18:31:00Z')), '26-27'); // 00:01 IST on 1 April
  });

  it('Aadhaar numbers are checked with the Verhoeff digit', () => {
    const prefix = '23412341234';
    const valid = [...'0123456789'].filter((d) => isValidAadhaarNumber(prefix + d));
    assert.equal(valid.length, 1, 'exactly one check digit fits');
    assert.ok(!isValidAadhaarNumber('123412341234'), 'cannot start with 0 or 1');
    assert.ok(!isValidAadhaarNumber('23412341234'), '12 digits');
  });
});

describe('v1.1 sign-in policy', () => {
  withPolicy({ AUTH_REQUIRE_EMAIL_VERIFIED: 'true', AUTH_REQUIRE_PHONE: 'true', AUTH_REQUIRE_LOGIN_OTP: 'true' });
  before(freshWorld);

  it('unverified email, then missing phone, then password-only session are each refused', async () => {
    const u = await makeUser();
    let r = await api().get(`${V}/bookings/me`).set(u.auth);
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'EMAIL_NOT_VERIFIED');

    await auth.updateUser(u.uid, { emailVerified: true });
    let token = await signIn(u.email);
    r = await api().get(`${V}/bookings/me`).set({ Authorization: `Bearer ${token}` });
    assert.equal(r.body.error.code, 'PHONE_NOT_VERIFIED');

    await auth.updateUser(u.uid, { phoneNumber: '+14155550123' });
    token = await signIn(u.email);
    r = await api().get(`${V}/bookings/me`).set({ Authorization: `Bearer ${token}` });
    assert.equal(r.body.error.code, 'PHONE_NOT_VERIFIED', 'only Indian mobiles');

    await auth.updateUser(u.uid, { phoneNumber: '+919812345670' });
    token = await signIn(u.email);
    r = await api().get(`${V}/bookings/me`).set({ Authorization: `Bearer ${token}` });
    assert.equal(r.body.error.code, 'LOGIN_OTP_REQUIRED', 'password alone is not enough');

    const status = await api().get(`${V}/auth/status`).set({ Authorization: `Bearer ${token}` });
    assert.equal(status.status, 200);
    assert.deepEqual(status.body.verification.pending, ['loginOtp']);
  });

  it('an SMS OTP sign-in (Firebase phone auth) passes and syncs the phone into the profile', async () => {
    const u = await makeUser();
    await auth.updateUser(u.uid, { emailVerified: true, phoneNumber: '+919812345671' });
    const token = await smsSignIn('+919812345671');
    const h = { Authorization: `Bearer ${token}` };
    const r = await api().get(`${V}/bookings/me`).set(h);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const me = await api().get(`${V}/me`).set(h);
    assert.equal(me.body.profile.phone, '+919812345671');
    assert.equal(me.body.verification.loginOtp, true);
    assert.deepEqual(me.body.verification.pending, []);
  });

  it('bootstrap takes the phone from the verified token, not the request body', async () => {
    const created = await auth.createUser({ email: `new${Date.now()}@test.local`, password: 'pass1234!', emailVerified: true, phoneNumber: '+919812345672' });
    const token = await smsSignIn('+919812345672');
    const r = await api().post(`${V}/auth/bootstrap`).set({ Authorization: `Bearer ${token}` }).send({ name: 'New Person', phone: '9000000000' });
    assert.equal(r.status, 201);
    assert.equal(r.body.profile.phone, '+919812345672');
    assert.equal(r.body.profile.uid, created.uid);
  });

  it('PATCH /me cannot change the phone (only an SMS OTP can)', async () => {
    const u = await makeUser();
    await auth.updateUser(u.uid, { emailVerified: true, phoneNumber: '+919812345673' });
    const h = { Authorization: `Bearer ${await smsSignIn('+919812345673')}` };
    const r = await api().patch(`${V}/me`).set(h).send({ phone: '9876543210' });
    assert.equal(r.status, 422);
  });
});

describe('v1.1 email OTP', () => {
  withPolicy({ AUTH_REQUIRE_EMAIL_VERIFIED: 'true' });
  before(freshWorld);
  beforeEach(() => outbox.splice(0));

  it('verify_email: wrong code counts, right code verifies the Firebase account', async () => {
    const u = await makeUser({ name: 'Otp Person' });
    let r = await api().post(`${V}/auth/email-otp/send`).set(u.auth).send({ purpose: 'verify_email' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const code = lastCode(u.email);
    assert.match(code, /^\d{6}$/);
    const mail = outbox.find((m) => m.to === u.email);
    assert.ok(!mail.subject.includes(code), 'code is never in the subject');
    assert.match(mail.html, /Otp Person/);

    const wrong = code === '000000' ? '111111' : '000000';
    r = await api().post(`${V}/auth/email-otp/verify`).set(u.auth).send({ purpose: 'verify_email', code: wrong });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'OTP_INVALID');
    assert.equal(r.body.error.details.attemptsLeft, 4);

    r = await api().post(`${V}/auth/email-otp/verify`).set(u.auth).send({ purpose: 'verify_email', code });
    assert.equal(r.status, 200);
    assert.equal(r.body.refreshToken, true);
    assert.equal((await auth.getUser(u.uid)).emailVerified, true);

    r = await api().post(`${V}/auth/email-otp/verify`).set(u.auth).send({ purpose: 'verify_email', code });
    assert.equal(r.body.error.code, 'OTP_EXPIRED', 'a code works once');
  });

  it('resend cooldown and lockout after 5 wrong attempts', async () => {
    const u = await makeUser();
    await api().post(`${V}/auth/email-otp/send`).set(u.auth).send({ purpose: 'verify_email' });
    const again = await api().post(`${V}/auth/email-otp/send`).set(u.auth).send({ purpose: 'verify_email' });
    assert.equal(again.status, 429, JSON.stringify(again.body));
    assert.equal(again.body.error.code, 'OTP_COOLDOWN');
    const code = lastCode(u.email);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await api().post(`${V}/auth/email-otp/verify`).set(u.auth).send({ purpose: 'verify_email', code: wrong });
    const r = await api().post(`${V}/auth/email-otp/verify`).set(u.auth).send({ purpose: 'verify_email', code });
    assert.equal(r.status, 429);
    assert.equal(r.body.error.code, 'OTP_LOCKED', 'even the right code is refused once locked');
  });

  it('OTP codes are stored only as a hash and are not readable by clients', async () => {
    const u = await makeUser();
    await api().post(`${V}/auth/email-otp/send`).set(u.auth).send({ purpose: 'verify_email' });
    const { emulatorCode, ...d } = (await db.collection('otps').doc(`${u.uid}_verify_email`).get()).data();
    // emulatorCode exists only on a local demo-* project (like the Auth emulator's SMS codes)
    assert.equal(emulatorCode, lastCode(u.email));
    assert.ok(!Object.values(d).some((v) => v === lastCode(u.email)));
    assert.match(d.codeHash, /^[0-9a-f]{64}$/);
  });
});

describe('v1.1 step-up OTP, Aadhaar OTP, booking emails with PDFs', () => {
  withPolicy({ AUTH_REQUIRE_EMAIL_VERIFIED: 'true', AUTH_REQUIRE_PHONE: 'true', AUTH_REQUIRE_STEP_UP: 'true' });
  let admin;
  let fd;
  let house;
  before(async () => {
    await freshWorld();
    admin = await verifiedUser({ role: 'admin' });
    fd = await verifiedUser({ role: 'frontdesk' });
    house = await buildHouse(admin, { roomsPerType: 4 });
    await api().patch(`${V}/settings`).set(admin.auth).send({ maxActiveBookings: 20, organisation: { name: 'IIT Demo Guest House', address: 'Campus, Kharagpur 721302', gstin: '19AAAAA0000A1Z5' } });
  });
  beforeEach(() => outbox.splice(0));

  async function stepUp(u) {
    await api().post(`${V}/auth/email-otp/send`).set(u.auth).send({ purpose: 'step_up' });
    const r = await api().post(`${V}/auth/email-otp/verify`).set(u.auth).send({ purpose: 'step_up', code: lastCode(u.email) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.stepUpUntil);
  }

  it('organisation settings validate the GSTIN', async () => {
    const r = await api().patch(`${V}/settings`).set(admin.auth).send({ organisation: { gstin: 'NOT-A-GSTIN' } });
    assert.equal(r.status, 400);
    const s = await api().get(`${V}/settings`).set(admin.auth);
    assert.equal(s.body.settings.organisation.name, 'IIT Demo Guest House');
    assert.equal(s.body.settings.organisation.sac, '996311', 'defaults kept for unset fields');
  });

  it('held booking email, then cash payment emails a confirmation with the receipt PDF', async () => {
    const g = await verifiedUser({ name: 'Ravi Kumar' });
    const b = (await api().post(`${V}/bookings`).set(g.auth).send({ roomId: house.rooms.std[0].id, checkIn: D(10), checkOut: D(12) })).body.booking;
    const held = outbox.find((m) => m.to === g.email && m.tag === 'booking.held');
    assert.ok(held, 'hold email');
    assert.match(held.html, /₹5,000\.00/);
    assert.match(held.text, new RegExp(dateIN(D(10)).replaceAll('/', '\\/')));

    outbox.splice(0);
    const pay = await api().post(`${V}/payments/cash`).set(fd.auth).send({ bookingId: b.id, amountPaise: b.amountPaise, note: 'counter' });
    assert.equal(pay.status, 201, JSON.stringify(pay.body));
    const conf = outbox.find((m) => m.to === g.email && m.tag === 'receipt');
    assert.ok(conf, 'confirmation email');
    assert.match(conf.subject, /Booking confirmed/);
    assert.equal(conf.attachments.length, 1);
    assert.match(conf.attachments[0].filename, /^RCPT-\d{2}-\d{2}-\d{6}\.pdf$/);
    assert.ok(conf.attachments[0].size > 2000);

    const rid = pay.body.receipt?.id ?? pay.body.receiptId;
    const pdf = await api().get(`${V}/receipts/${rid}/pdf`).set(g.auth).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.match(pdf.headers['content-disposition'], /RCPT-\d{2}-\d{2}-\d{6}\.pdf/);
    assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');
    const snap = (await db.collection('receipts').doc(rid).get()).data().snapshot;
    assert.equal(snap.organisation.name, 'IIT Demo Guest House', 'organisation frozen on the receipt');
  });

  it('cancelling needs a step-up email OTP, then emails the cancellation', async () => {
    const g = await verifiedUser({ name: 'Cancel Person' });
    const b = (await api().post(`${V}/bookings`).set(g.auth).send({ roomId: house.rooms.std[1].id, checkIn: D(20), checkOut: D(21) })).body.booking;
    let r = await api().post(`${V}/bookings/${b.id}/cancel`).set(g.auth).send({ reason: 'plans changed' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'STEP_UP_REQUIRED');
    await stepUp(g);
    outbox.splice(0);
    r = await api().post(`${V}/bookings/${b.id}/cancel`).set(g.auth).send({ reason: 'plans changed' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(outbox.some((m) => m.to === g.email && m.tag === 'booking.cancelled'));
  });

  describe('Aadhaar OTP (mock provider)', () => {
    let saved;
    before(() => {
      saved = process.env.AADHAAR_OTP_PROVIDER;
      process.env.AADHAAR_OTP_PROVIDER = 'mock';
    });
    after(() => {
      process.env.AADHAAR_OTP_PROVIDER = saved;
    });
    const number = (prefix) => prefix + [...'0123456789'].find((d) => isValidAadhaarNumber(prefix + d));

    it('validates the number, needs step-up, verifies with the OTP and stores only last4', async () => {
      const g = await verifiedUser({ verified: false, name: 'Meena Iyer' });
      const aadhaarNumber = number('98765432101');
      let r = await api().post(`${V}/me/aadhaar/otp/send`).set(g.auth).send({ aadhaarNumber, consent: true });
      assert.equal(r.body.error.code, 'STEP_UP_REQUIRED');
      await stepUp(g);
      r = await api().post(`${V}/me/aadhaar/otp/send`).set(g.auth).send({ aadhaarNumber: '987654321012', consent: true });
      assert.equal(r.status, isValidAadhaarNumber('987654321012') ? 200 : 400);
      r = await api().post(`${V}/me/aadhaar/otp/send`).set(g.auth).send({ aadhaarNumber: `${aadhaarNumber.slice(0, 4)} ${aadhaarNumber.slice(4, 8)} ${aadhaarNumber.slice(8)}`, consent: true });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.last4, aadhaarNumber.slice(-4));
      const { sessionId } = r.body;

      r = await api().post(`${V}/me/aadhaar/otp/verify`).set(g.auth).send({ sessionId, otp: '000000' });
      assert.equal(r.status, 422);
      r = await api().post(`${V}/me/aadhaar/otp/verify`).set(g.auth).send({ sessionId, otp: '123456' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.method, 'otp');

      const me = await api().get(`${V}/me`).set(g.auth);
      assert.equal(me.body.profile.verified, true);
      assert.equal(me.body.profile.aadhaar.method, 'otp');
      const session = (await db.collection('aadhaarOtpSessions').doc(sessionId).get()).data();
      assert.ok(!JSON.stringify(session).includes(aadhaarNumber), 'full number never stored');

      r = await api().post(`${V}/me/aadhaar/otp/verify`).set(g.auth).send({ sessionId, otp: '123456' });
      assert.equal(r.body.error.code, 'OTP_EXPIRED', 'session is single-use');
    });

    it('another user cannot use someone else\'s session', async () => {
      const a = await verifiedUser({ verified: false, name: 'Sita Rao' });
      await stepUp(a);
      const s = await api().post(`${V}/me/aadhaar/otp/send`).set(a.auth).send({ aadhaarNumber: number('87654321098'), consent: true });
      const b = await verifiedUser({ verified: false, name: 'Sita Rao' });
      const r = await api().post(`${V}/me/aadhaar/otp/verify`).set(b.auth).send({ sessionId: s.body.sessionId, otp: '123456' });
      assert.equal(r.status, 404);
    });
  });
});

describe('v1.1 document numbers follow the Indian financial year', () => {
  it('INV/26-27/000001 style, at most 16 characters', async () => {
    const { formatNumber } = await import('../src/lib/counters.js');
    const n = formatNumber('INV', fyIST(Date.parse('2026-10-21T00:00:00Z')), 1);
    assert.equal(n, 'INV/26-27/000001');
    assert.ok(n.length <= 16);
  });
});
