import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, V, freshWorld, makeUser, auth, db, auditFor, sleep, signIn } from './helpers.js';
import { buildQr, useTestCert, otherSigner } from './qr.js';
import { decodeSecureQr, namesMatch } from '../src/lib/aadhaarQr.js';

const verify = (u, body) => api().post(`${V}/me/aadhaar/verify-qr`).set(u.auth).send(body);

describe('v0.2 Aadhaar QR decoder (unit)', () => {
  before(useTestCert);

  it('decodes V2 and legacy (V1) layouts', () => {
    for (const version of ['V2', null]) {
      const d = decodeSecureQr(buildQr({ version, name: 'Ravi Kumar', last4: '9988', dob: '01-02-1990' }));
      assert.equal(d.last4, '9988');
      assert.equal(d.name, 'Ravi Kumar');
      assert.equal(d.birthYear, 1990);
      assert.equal(d.signatureVerified, true);
    }
  });

  it('rejects a QR signed by a different key', () => {
    assert.throws(() => decodeSecureQr(buildQr({ signWith: otherSigner })), (e) => e.code === 'INVALID_QR' && e.details.reason === 'BAD_SIGNATURE');
  });

  it('rejects a tampered QR (name changed after signing)', () => {
    const qr = buildQr({ name: 'Asha Verma', tamper: (b) => Buffer.from(b.toString('latin1').replace('Asha Verma', 'Usha Verma'), 'latin1') });
    assert.throws(() => decodeSecureQr(qr), (e) => e.details.reason === 'BAD_SIGNATURE');
  });

  it('rejects a typed Aadhaar number / photo text / random digits', () => {
    for (const bad of ['1234 5678 9012', '123456789012', 'https://example.com', '9'.repeat(500)]) {
      assert.throws(() => decodeSecureQr(bad), (e) => e.code === 'INVALID_QR');
    }
  });

  it('fails closed when the UIDAI certificate is missing', () => {
    const prev = process.env.UIDAI_CERT_PATH;
    process.env.UIDAI_CERT_PATH = '/nonexistent/cert.pem';
    try {
      assert.throws(() => decodeSecureQr(buildQr()), (e) => e.details.reason === 'NO_CERT');
      process.env.AADHAAR_ALLOW_UNSIGNED = 'true';
      assert.equal(decodeSecureQr(buildQr()).signatureVerified, false);
    } finally {
      delete process.env.AADHAAR_ALLOW_UNSIGNED;
      process.env.UIDAI_CERT_PATH = prev;
    }
  });

  it('name matching: case/space-insensitive, initials allowed', () => {
    assert.ok(namesMatch('asha  verma', 'ASHA VERMA'));
    assert.ok(namesMatch('A. Verma', 'Asha Verma'));
    assert.ok(namesMatch('Asha Verma', 'A Verma'));
    assert.ok(!namesMatch('Asha Verma', 'Usha Verma'));
    assert.ok(!namesMatch('Asha', 'Asha Verma'));
  });
});

describe('v0.2 users, Aadhaar verification, officials (API)', () => {
  before(async () => {
    useTestCert();
    await freshWorld();
  });

  it('consent is required', async () => {
    const u = await makeUser({ verified: false, name: 'Asha Verma' });
    const r = await verify(u, { qrData: buildQr(), consent: false });
    assert.equal(r.status, 400);
    const r2 = await verify(u, { qrData: buildQr() });
    assert.equal(r2.status, 400);
  });

  it('a valid QR verifies and stores only last4, name, birth year', async () => {
    const u = await makeUser({ verified: false, name: 'Asha Verma' });
    const r = await verify(u, { qrData: buildQr({ last4: '4321', name: 'Asha Verma' }), consent: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual({ verified: r.body.verified, last4: r.body.last4 }, { verified: true, last4: '4321' });
    const a = (await db.doc(`users/${u.uid}`).get()).data().aadhaar;
    assert.deepEqual(Object.keys(a).sort(), ['birthYear', 'consentAt', 'last4', 'method', 'signatureVerified', 'verifiedAt', 'verifiedName']);
    assert.equal(a.method, 'qr');
    const me = await api().get(`${V}/me`).set(u.auth);
    assert.equal(me.body.profile.verified, true);
  });

  it('a photo of a printed number / tampered QR does not verify', async () => {
    const u = await makeUser({ verified: false, name: 'Neha Rao' });
    let r = await verify(u, { qrData: '987654321098', consent: true });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'INVALID_QR');
    r = await verify(u, { qrData: buildQr({ name: 'Neha Rao', signWith: otherSigner }), consent: true });
    assert.equal(r.body.error.code, 'INVALID_QR');
  });

  it('name on the QR must match the profile', async () => {
    const u = await makeUser({ verified: false, name: 'Karan Mehta' });
    const r = await verify(u, { qrData: buildQr({ name: 'Someone Else', last4: '1111' }), consent: true });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.details.reason, 'NAME_MISMATCH');
  });

  it('the same Aadhaar cannot verify a second account', async () => {
    const qrArgs = { last4: '7777', name: 'Priya Shah', dob: '10-10-1992' };
    const a = await makeUser({ verified: false, name: 'Priya Shah' });
    const b = await makeUser({ verified: false, name: 'Priya Shah' });
    assert.equal((await verify(a, { qrData: buildQr(qrArgs), consent: true })).status, 200);
    // a freshly generated QR of the same person (new timestamp) is still the same Aadhaar
    const r = await verify(b, { qrData: buildQr({ ...qrArgs, timestamp: '20261021120000000' }), consent: true });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'AADHAAR_IN_USE');
    const again = await verify(a, { qrData: buildQr(qrArgs), consent: true });
    assert.equal(again.status, 409, 'cannot re-verify an already verified account');
  });

  it('no Firestore document or log line contains more than 4 Aadhaar digits', async () => {
    const lines = [];
    const origLog = console.log;
    const origErr = console.error;
    process.env.LOG_SILENT = 'false';
    console.log = (...a) => lines.push(a.join(' '));
    console.error = (...a) => lines.push(a.join(' '));
    const ts = '20261021093000123';
    const qrData = buildQr({ last4: '5050', name: 'Log Tester', timestamp: ts });
    try {
      const u = await makeUser({ verified: false, name: 'Log Tester' });
      await verify(u, { qrData, consent: true });
      await verify(u, { qrData: 'garbage-data', consent: true });
    } finally {
      console.log = origLog;
      console.error = origErr;
      process.env.LOG_SILENT = 'true';
    }
    const dump = [];
    for (const col of await db.listCollections()) {
      for (const d of (await col.get()).docs) dump.push(JSON.stringify(d.data()));
    }
    const all = dump.join('\n') + lines.join('\n');
    assert.ok(!all.includes(`5050${ts}`), 'reference id must not be stored or logged');
    assert.ok(!all.includes(qrData.slice(0, 40)), 'raw QR must not be stored or logged');
    assert.ok(!/\b\d{12}\b/.test(all), 'no 12-digit number anywhere');
    const audits = (await db.collection('auditLogs').where('action', '==', 'user.aadhaar.verify').get()).docs.map((d) => d.data());
    for (const a of audits) assert.ok(!JSON.stringify(a).includes('last4'), 'audit excludes Aadhaar data');
  });

  it('PATCH /me updates name/phone only', async () => {
    const u = await makeUser();
    let r = await api().patch(`${V}/me`).set(u.auth).send({ phone: '+919876543210' });
    assert.equal(r.status, 200);
    assert.equal(r.body.profile.phone, '+919876543210');
    r = await api().patch(`${V}/me`).set(u.auth).send({ role: 'admin' });
    assert.equal(r.status, 400);
    r = await api().patch(`${V}/me`).set(u.auth).send({ categoryId: 'official' });
    assert.equal(r.status, 400);
  });

  it('official request → admin approves → claims change to official', async () => {
    const admin = await makeUser({ role: 'admin' });
    const g = await makeUser({ role: 'guest' });
    let r = await api().post(`${V}/me/official-request`).set(g.auth).send({ department: 'Physics', designation: 'Professor', officialEmail: 'prof@univ.edu' });
    assert.equal(r.status, 201);
    const id = r.body.request.id;
    r = await api().post(`${V}/me/official-request`).set(g.auth).send({ department: 'Physics', designation: 'Professor', officialEmail: 'prof@univ.edu' });
    assert.equal(r.status, 409, 'only one pending request');

    r = await api().get(`${V}/admin/official-requests?status=pending`).set(admin.auth);
    assert.ok(r.body.items.some((x) => x.id === id));
    r = await api().get(`${V}/admin/official-requests?status=pending`).set(g.auth);
    assert.equal(r.status, 403);

    await sleep(1100);
    r = await api().post(`${V}/admin/official-requests/${id}/decide`).set(admin.auth).send({ approve: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.request.status, 'approved');
    const claims = (await auth.getUser(g.uid)).customClaims;
    assert.equal(claims.role, 'official');
    assert.equal(claims.categoryId, 'official');
    const old = await api().get(`${V}/me`).set(g.auth);
    assert.equal(old.body.error.code, 'TOKEN_REVOKED');
    const t = await signIn(g.email);
    const me = await api().get(`${V}/me`).set('Authorization', `Bearer ${t}`);
    assert.equal(me.body.profile.role, 'official');
    assert.equal(me.body.profile.officialStatus, 'approved');
    r = await api().post(`${V}/admin/official-requests/${id}/decide`).set(admin.auth).send({ approve: false, reason: 'changed my mind' });
    assert.equal(r.status, 409, 'cannot decide twice');
    assert.ok((await auditFor('user', g.uid)).some((a) => a.action === 'user.role.change' && a.after.role === 'official'));
  });

  it('rejecting needs a reason', async () => {
    const admin = await makeUser({ role: 'admin' });
    const g = await makeUser({ role: 'guest' });
    const r0 = await api().post(`${V}/me/official-request`).set(g.auth).send({ department: 'Maths', designation: 'Lecturer', officialEmail: 'l@univ.edu' });
    let r = await api().post(`${V}/admin/official-requests/${r0.body.request.id}/decide`).set(admin.auth).send({ approve: false });
    assert.equal(r.status, 400);
    r = await api().post(`${V}/admin/official-requests/${r0.body.request.id}/decide`).set(admin.auth).send({ approve: false, reason: 'not on staff list' });
    assert.equal(r.status, 200);
    assert.equal((await db.doc(`users/${g.uid}`).get()).data().officialStatus, 'rejected');
  });

  it('only guests may request official status', async () => {
    const f = await makeUser({ role: 'frontdesk' });
    const r = await api().post(`${V}/me/official-request`).set(f.auth).send({ department: 'X1', designation: 'Y1', officialEmail: 'a@b.co' });
    assert.equal(r.status, 403);
  });

  it('walk-in: front desk creates a verified guest; duplicates are refused; other roles refused', async () => {
    const fd = await makeUser({ role: 'frontdesk' });
    const body = { name: 'Walk In', phone: '9000000001', email: 'walkin@test.local', qrData: buildQr({ name: 'Walk In', last4: '2468' }), consent: true };
    let r = await api().post(`${V}/frontdesk/walk-in`).set(fd.auth).send(body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.profile.verified, true);
    assert.equal(r.body.profile.role, 'guest');
    assert.equal((await auth.getUser(r.body.profile.uid)).customClaims.role, 'guest');
    r = await api().post(`${V}/frontdesk/walk-in`).set(fd.auth).send({ ...body, email: 'walkin2@test.local', qrData: buildQr({ name: 'Walk In', last4: '2468' }) });
    assert.equal(r.body.error.code, 'AADHAAR_IN_USE');
    await assert.rejects(auth.getUserByEmail('walkin2@test.local'), 'no orphan Auth user is left behind');
    const g = await makeUser({ role: 'guest' });
    r = await api().post(`${V}/frontdesk/walk-in`).set(g.auth).send(body);
    assert.equal(r.status, 403);
  });

  it('admin lists/filters users and suspends with a mandatory reason', async () => {
    const admin = await makeUser({ role: 'admin' });
    const g = await makeUser({ role: 'guest', name: 'Zed Suspend' });
    let r = await api().get(`${V}/admin/users?role=guest&limit=100`).set(admin.auth);
    assert.equal(r.status, 200);
    assert.ok(r.body.items.every((u) => u.role === 'guest'));
    r = await api().get(`${V}/admin/users?q=Zed`).set(admin.auth);
    assert.equal(r.body.items[0].uid, g.uid);
    r = await api().get(`${V}/admin/users?q=${encodeURIComponent(g.email)}`).set(admin.auth);
    assert.equal(r.body.items.length, 1);

    r = await api().patch(`${V}/admin/users/${g.uid}`).set(admin.auth).send({ status: 'suspended' });
    assert.equal(r.status, 400, 'reason required');
    await sleep(1100);
    r = await api().patch(`${V}/admin/users/${g.uid}`).set(admin.auth).send({ status: 'suspended', reason: 'abusive behaviour' });
    assert.equal(r.status, 200);
    const t = await signIn(g.email);
    r = await api().get(`${V}/me`).set('Authorization', `Bearer ${t}`);
    assert.equal(r.body.error.code, 'SUSPENDED');
    r = await api().patch(`${V}/admin/users/${g.uid}`).set(admin.auth).send({ categoryId: 'nope', reason: 'test reason' });
    assert.equal(r.status, 422);
    r = await api().patch(`${V}/admin/users/${g.uid}`).set(admin.auth).send({ status: 'active', categoryId: 'faculty', reason: 'appeal accepted' });
    assert.equal(r.status, 200);
    assert.equal(r.body.profile.categoryId, 'faculty');
    const audits = await auditFor('user', g.uid);
    assert.ok(audits.some((a) => a.action === 'user.suspend' && a.reason === 'abusive behaviour'));
  });
});
