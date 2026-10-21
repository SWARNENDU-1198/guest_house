import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, V, freshWorld, makeUser, db, auditFor } from './helpers.js';
import { buildHouse } from './fixtures.js';
import { todayIST, addDays } from '../src/lib/dates.js';
import { mockGateway } from '../src/lib/razorpay.js';
import { Timestamp } from '../src/firebase.js';

const D = (n) => addDays(todayIST(), n);
let evt = 0;

function webhook(event, entity, { sign = true, eventId, tamper } = {}) {
  const body = JSON.stringify({ entity: 'event', event, payload: { payment: { entity } }, created_at: Math.floor(Date.now() / 1000) });
  const sig = sign ? mockGateway.signWebhook(body) : 'deadbeef';
  return api()
    .post(`${V}/webhooks/razorpay`)
    .set('Content-Type', 'application/json')
    .set('X-Razorpay-Signature', sig)
    .set('X-Razorpay-Event-Id', eventId ?? `evt_test_${++evt}_${Date.now()}`)
    .send(tamper ? tamper(body) : body);
}
const receiptsFor = async (bookingId) => (await db.collection('receipts').where('bookingId', '==', bookingId).where('kind', '==', 'receipt').get()).docs.map((d) => d.data());

describe('v0.6 payments and receipts', () => {
  let admin;
  let guest;
  let acc;
  before(async () => {
    await freshWorld();
    mockGateway.reset();
    admin = await makeUser({ role: 'admin' });
    acc = await makeUser({ role: 'accounts' });
    guest = await makeUser({ name: 'Paying Guest' });
    await buildHouse(admin, { roomsPerType: 6 });
    await api().patch(`${V}/settings`).set(admin.auth).send({ maxActiveBookings: 20 });
  });

  const hold = async (u, roomId, a = 3, b = 5) => (await api().post(`${V}/bookings`).set(u.auth).send({ roomId, checkIn: D(a), checkOut: D(b) })).body.booking;
  const order = (u, body) => api().post(`${V}/payments/order`).set(u.auth).send(body);

  it('order amount comes from the rate snapshot; client amounts are rejected; only keyId is exposed', async () => {
    const b = await hold(guest, 'r101');
    let r = await order(guest, { bookingId: b.id, amountPaise: 100 });
    assert.equal(r.status, 400, 'unknown field amountPaise rejected');
    r = await order(guest, { bookingId: b.id });
    assert.equal(r.status, 201);
    assert.equal(r.body.amount, b.amountPaise);
    assert.equal(r.body.keyId, 'rzp_test_mock');
    assert.ok(!JSON.stringify(r.body).toLowerCase().includes('secret'));
    const stranger = await makeUser();
    assert.equal((await order(stranger, { bookingId: b.id })).status, 404);
  });

  it('a forged checkout signature -> 400, booking stays held', async () => {
    const b = await hold(guest, 'r102');
    const o = (await order(guest, { bookingId: b.id })).body;
    const { payment } = mockGateway.pay(o.orderId);
    const r = await api().post(`${V}/payments/verify`).set(guest.auth).send({ razorpay_order_id: o.orderId, razorpay_payment_id: payment.id, razorpay_signature: 'f'.repeat(64) });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'PAYMENT_FAILED');
    assert.equal((await db.doc(`bookings/${b.id}`).get()).data().state, 'held');
  });

  it('verify + webhook arriving together confirm the booking and create exactly one receipt', async () => {
    const b = await hold(guest, 'r103');
    const o = (await order(guest, { bookingId: b.id })).body;
    const { payment, signature } = mockGateway.pay(o.orderId);
    const entity = { id: payment.id, order_id: o.orderId, amount: o.amount, status: 'captured', method: 'upi' };
    const [v, w1, w2] = await Promise.all([
      api().post(`${V}/payments/verify`).set(guest.auth).send({ razorpay_order_id: o.orderId, razorpay_payment_id: payment.id, razorpay_signature: signature }),
      webhook('payment.captured', entity),
      webhook('order.paid', entity),
    ]);
    assert.equal(v.status, 200, JSON.stringify(v.body));
    assert.equal(w1.status, 200);
    assert.equal(w2.status, 200);
    const booking = (await db.doc(`bookings/${b.id}`).get()).data();
    assert.equal(booking.state, 'confirmed');
    assert.equal(booking.paidPaise, b.amountPaise);
    assert.equal((await receiptsFor(b.id)).length, 1);
    const nights = await db.collection('roomNights').where('bookingId', '==', b.id).get();
    assert.ok(nights.docs.every((d) => d.data().state === 'booked'));
    const again = await api().post(`${V}/payments/verify`).set(guest.auth).send({ razorpay_order_id: o.orderId, razorpay_payment_id: payment.id, razorpay_signature: signature });
    assert.equal(again.body.status, 'already');
    assert.equal((await receiptsFor(b.id)).length, 1);
  });

  it('a duplicate webhook delivery (same event id) does nothing', async () => {
    const b = await hold(guest, 'r104');
    const o = (await order(guest, { bookingId: b.id })).body;
    const { payment } = mockGateway.pay(o.orderId);
    const entity = { id: payment.id, order_id: o.orderId, amount: o.amount, status: 'captured', method: 'card' };
    const r1 = await webhook('payment.captured', entity, { eventId: 'evt_dup_1' });
    const r2 = await webhook('payment.captured', entity, { eventId: 'evt_dup_1' });
    assert.equal(r1.body.outcome, 'confirmed');
    assert.equal(r2.body.duplicate, true);
    assert.equal((await receiptsFor(b.id)).length, 1);
    assert.equal((await db.doc('webhookEvents/evt_dup_1').get()).data().processed, true);
  });

  it('the webhook alone confirms (browser closed after paying)', async () => {
    const b = await hold(guest, 'r105', 8, 9);
    const o = (await order(guest, { bookingId: b.id })).body;
    const { payment } = mockGateway.pay(o.orderId);
    await webhook('payment.captured', { id: payment.id, order_id: o.orderId, amount: o.amount, status: 'captured', method: 'netbanking' });
    assert.equal((await db.doc(`bookings/${b.id}`).get()).data().state, 'confirmed');
  });

  it('a forged webhook (bad signature or tampered body) -> 400 and nothing changes', async () => {
    const b = await hold(guest, 'r106', 8, 9);
    const o = (await order(guest, { bookingId: b.id })).body;
    const { payment } = mockGateway.pay(o.orderId);
    const entity = { id: payment.id, order_id: o.orderId, amount: o.amount, status: 'captured', method: 'upi' };
    let r = await webhook('payment.captured', entity, { sign: false });
    assert.equal(r.status, 400);
    const signedThenTampered = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity } } });
    r = await api().post(`${V}/webhooks/razorpay`).set('Content-Type', 'application/json').set('X-Razorpay-Signature', mockGateway.signWebhook(signedThenTampered)).send(signedThenTampered.replace(String(o.amount), '1'));
    assert.equal(r.status, 400);
    r = await api().post(`${V}/webhooks/razorpay`).set('Content-Type', 'application/json').send(JSON.stringify({ event: 'payment.captured', payload: { payment: { entity } } }));
    assert.equal(r.status, 400, 'missing signature');
    assert.equal((await db.doc(`bookings/${b.id}`).get()).data().state, 'held');
    const pay = await db.collection('payments').where('orderId', '==', o.orderId).get();
    assert.equal(pay.docs[0].data().status, 'created');
    assert.equal((await receiptsFor(b.id)).length, 0);
  });

  it('changing the amount in the browser has no effect: a different amount is flagged, not confirmed', async () => {
    const b = await hold(guest, 'r101', 12, 13);
    const o = (await order(guest, { bookingId: b.id })).body;
    const { payment } = mockGateway.pay(o.orderId, { amount: 100 });
    const r = await webhook('payment.captured', { id: payment.id, order_id: o.orderId, amount: 100, status: 'captured', method: 'upi' });
    assert.equal(r.body.outcome, 'mismatch');
    assert.equal((await db.doc(`bookings/${b.id}`).get()).data().state, 'held');
  });

  it('payment.failed marks the payment failed; the hold stays so the user can retry', async () => {
    const b = await hold(guest, 'r102', 14, 15);
    const o = (await order(guest, { bookingId: b.id })).body;
    await webhook('payment.failed', { id: 'pay_failed_1', order_id: o.orderId, amount: o.amount, status: 'failed', error_description: 'Card declined' });
    const p = (await db.collection('payments').where('orderId', '==', o.orderId).get()).docs[0].data();
    assert.equal(p.status, 'failed');
    assert.equal((await db.doc(`bookings/${b.id}`).get()).data().state, 'held');
  });

  it('expired hold: order refused with HOLD_EXPIRED', async () => {
    const u = await makeUser();
    const b = await hold(u, 'r103', 20, 21);
    await db.doc(`bookings/${b.id}`).update({ holdExpiresAt: Timestamp.fromMillis(Date.now() - 1000) });
    const r = await order(u, { bookingId: b.id });
    assert.equal(r.body.error.code, 'HOLD_EXPIRED');
  });

  it('paid after the hold expired: nights still free -> re-locked and confirmed', async () => {
    const u = await makeUser();
    const b = await hold(u, 'r104', 22, 23);
    const o = (await order(u, { bookingId: b.id })).body;
    await db.doc(`bookings/${b.id}`).update({ holdExpiresAt: Timestamp.fromMillis(Date.now() - 1000) });
    await api().post(`${V}/admin/jobs/expireHolds/run`).set(admin.auth).send({});
    assert.equal((await db.doc(`bookings/${b.id}`).get()).data().state, 'expired');
    const { payment } = mockGateway.pay(o.orderId);
    const r = await webhook('payment.captured', { id: payment.id, order_id: o.orderId, amount: o.amount, status: 'captured', method: 'upi' });
    assert.equal(r.body.outcome, 'confirmed');
    assert.equal((await db.doc(`bookings/${b.id}`).get()).data().state, 'confirmed');
    assert.equal((await db.doc(`roomNights/r104_${D(22)}`).get()).data().bookingId, b.id);
  });

  it('paid after the hold expired and the room was taken -> automatic refund', async () => {
    const u = await makeUser();
    const b = await hold(u, 'r105', 24, 25);
    const o = (await order(u, { bookingId: b.id })).body;
    await db.doc(`bookings/${b.id}`).update({ holdExpiresAt: Timestamp.fromMillis(Date.now() - 1000) });
    await api().post(`${V}/admin/jobs/expireHolds/run`).set(admin.auth).send({});
    const other = await makeUser();
    assert.equal((await hold(other, 'r105', 24, 25)).state, 'held');
    const { payment } = mockGateway.pay(o.orderId);
    const r = await webhook('payment.captured', { id: payment.id, order_id: o.orderId, amount: o.amount, status: 'captured', method: 'upi' });
    assert.equal(r.body.outcome, 'refund_needed');
    const p = (await db.collection('payments').where('orderId', '==', o.orderId).get()).docs[0].data();
    assert.equal(p.status, 'refunded');
    assert.equal(p.refundedPaise, o.amount);
    assert.equal((await db.doc(`bookings/${b.id}`).get()).data().state, 'expired');
    assert.equal((await receiptsFor(b.id)).length, 0);
  });

  it('receipt numbers are gap-free and never repeat (10 concurrent cash payments)', async () => {
    const fd = await makeUser({ role: 'frontdesk' });
    const users = await Promise.all(Array.from({ length: 10 }, () => makeUser()));
    const bookings = [];
    for (const [i, u] of users.entries()) bookings.push(await hold(u, ['r101', 'r102', 'r103', 'r104', 'r105', 'r106'][i % 6], 30 + Math.floor(i / 6) * 2, 31 + Math.floor(i / 6) * 2));
    const res = await Promise.all(bookings.map((b) => api().post(`${V}/payments/cash`).set(fd.auth).send({ bookingId: b.id, amountPaise: b.amountPaise, note: 'counter' })));
    assert.ok(res.every((r) => r.status === 201), JSON.stringify(res.map((r) => r.body)));
    const all = (await db.collection('receipts').where('kind', '==', 'receipt').get()).docs.map((d) => d.data().number).sort();
    assert.equal(new Set(all).size, all.length, 'no repeats');
    const nums = all.map((n) => Number(n.split('-')[2]));
    assert.deepEqual(nums, Array.from({ length: nums.length }, (_, i) => i + 1), 'gap-free 1..N');
    assert.match(all[0], /^RCPT-\d{4}-000001$/);
  });

  it('cash: only front desk / accounts; amount must equal what is due; no double collection', async () => {
    const u = await makeUser();
    const b = await hold(u, 'r106', 40, 41);
    assert.equal((await api().post(`${V}/payments/cash`).set(u.auth).send({ bookingId: b.id, amountPaise: b.amountPaise })).status, 403);
    assert.equal((await api().post(`${V}/payments/cash`).set(acc.auth).send({ bookingId: b.id, amountPaise: 5 })).status, 422);
    assert.equal((await api().post(`${V}/payments/cash`).set(acc.auth).send({ bookingId: b.id, amountPaise: b.amountPaise })).status, 201);
    assert.equal((await api().post(`${V}/payments/cash`).set(acc.auth).send({ bookingId: b.id, amountPaise: b.amountPaise })).status, 422);
  });

  it('refunds: accounts refunds part of a payment and gets a credit note; cannot exceed what was paid', async () => {
    const u = await makeUser();
    const b = await hold(u, 'r101', 42, 44);
    const cash = await api().post(`${V}/payments/cash`).set(acc.auth).send({ bookingId: b.id, amountPaise: b.amountPaise });
    const pid = cash.body.payment.id;
    assert.equal((await api().post(`${V}/payments/${pid}/refund`).set(u.auth).send({ amountPaise: 100, reason: 'self refund' })).status, 403);
    let r = await api().post(`${V}/payments/${pid}/refund`).set(acc.auth).send({ amountPaise: 100000, reason: 'early departure' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.payment.status, 'partially_refunded');
    assert.match(r.body.creditNote.number, /^CN-\d{4}-\d{6}$/);
    r = await api().post(`${V}/payments/${pid}/refund`).set(acc.auth).send({ amountPaise: b.amountPaise, reason: 'too much' });
    assert.equal(r.status, 422);
    assert.ok((await auditFor('payment', pid)).some((a) => a.action === 'payment.refund' && a.reason === 'early departure'));
  });

  it('receipts: list mine, JSON, and PDF; strangers get 404', async () => {
    const mine = await api().get(`${V}/receipts/me`).set(guest.auth);
    assert.ok(mine.body.items.length >= 1);
    const rc = mine.body.items[0];
    assert.equal(rc.snapshot.guest.name, 'Paying Guest');
    assert.equal(rc.snapshot.guest.aadhaarLast4, '1234');
    const pdf = await api().get(`${V}/receipts/${rc.id}/pdf`).set(guest.auth).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');
    const stranger = await makeUser();
    assert.equal((await api().get(`${V}/receipts/${rc.id}/pdf`).set(stranger.auth)).status, 404);
    const fd = await makeUser({ role: 'frontdesk' });
    assert.equal((await api().get(`${V}/receipts/${rc.id}`).set(fd.auth)).status, 200);
  });

  it('officials get a ₹0 confirmation slip', async () => {
    const o = await makeUser({ role: 'official' });
    const raw = await api().post(`${V}/bookings`).set(o.auth).send({ roomId: 'r106', checkIn: D(28), checkOut: D(29) });
    assert.equal(raw.status, 201, JSON.stringify(raw.body));
    const b = raw.body.booking;
    assert.equal(b.state, 'confirmed');
    const slip = (await db.doc(`receipts/${b.slipId}`).get()).data();
    assert.equal(slip.kind, 'slip');
    assert.equal(slip.snapshot.totalPaise, 0);
    assert.match(slip.number, /^SLIP-\d{4}-\d{6}$/);
  });

  it('accounts lists payments; guests cannot', async () => {
    const r = await api().get(`${V}/payments?status=captured`).set(acc.auth);
    assert.equal(r.status, 200);
    assert.ok(r.body.items.every((p) => p.status === 'captured'));
    assert.equal((await api().get(`${V}/payments`).set(guest.auth)).status, 403);
  });

  it('pay-later invoice can be paid online', async () => {
    const f = await makeUser({ categoryId: 'faculty' });
    const b = (await api().post(`${V}/bookings`).set(f.auth).send({ roomId: 'r102', checkIn: D(55), checkOut: D(56), payLater: true })).body.booking;
    const o = (await order(f, { invoiceId: b.invoiceId })).body;
    assert.equal(o.amount, b.amountPaise);
    const { payment } = mockGateway.pay(o.orderId);
    await webhook('payment.captured', { id: payment.id, order_id: o.orderId, amount: o.amount, status: 'captured', method: 'upi' });
    const inv = (await db.doc(`invoices/${b.invoiceId}`).get()).data();
    assert.equal(inv.status, 'paid');
    assert.equal(inv.nextReminderAt, null);
  });
});
