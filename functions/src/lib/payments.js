import { db, FieldValue } from '../firebase.js';
import { notFound, conflict, unprocessable, CODES } from '../middleware/errors.js';
import { writeAudit } from './audit.js';
import { nightsBetween } from './dates.js';
import { nightRef } from './nights.js';
import { prepareReceipt } from './receipts.js';
import { refundPayment } from './razorpay.js';
import { sendMail, appUrl } from './mailer.js';
import { log } from './log.js';

export const SETTLED = ['captured', 'refund_pending', 'refunded', 'partially_refunded'];

export async function findPaymentByOrder(tx, orderId) {
  const q = db.collection('payments').where('orderId', '==', orderId).limit(1);
  const snap = tx ? await tx.get(q) : await q.get();
  return snap.empty ? null : snap.docs[0];
}

// The one confirmation path shared by checkout verify, webhook, reconciliation
// and cash. Idempotent: a settled payment is returned as-is, so verify + webhook
// arriving together produce exactly one receipt.
//
// payment: { ref, data, isNew }  (isNew: cash payments created in this same transaction)
async function confirmInTx(tx, { payment, gatewayPaymentId, amountPaise, method, source, actor }) {
  const p = payment.data;
  if (!payment.isNew && SETTLED.includes(p.status)) {
    return { status: 'already', paymentId: payment.ref.id, receiptId: p.receiptId ?? null, bookingId: p.bookingId, invoiceId: p.invoiceId };
  }
  if (amountPaise !== p.amountPaise) {
    tx.update(payment.ref, { status: 'mismatch', gatewayPaymentId, reportedAmountPaise: amountPaise, updatedAt: FieldValue.serverTimestamp() });
    writeAudit(tx, actor, { action: 'payment.mismatch', entity: 'payment', entityId: payment.ref.id, before: { amountPaise: p.amountPaise }, after: { amountPaise } });
    return { status: 'mismatch', paymentId: payment.ref.id };
  }

  // ---------------- reads ----------------
  let booking = null;
  let bookingRef = null;
  let invoice = null;
  let invoiceRef = null;
  let nightSnaps = [];
  let queueSnap = null;
  if (p.invoiceId) {
    invoiceRef = db.collection('invoices').doc(p.invoiceId);
    const s = await tx.get(invoiceRef);
    if (!s.exists) throw notFound('Invoice');
    invoice = s.data();
    if (invoice.bookingId) {
      bookingRef = db.collection('bookings').doc(invoice.bookingId);
      booking = (await tx.get(bookingRef)).data() ?? null;
    }
  } else {
    bookingRef = db.collection('bookings').doc(p.bookingId);
    const s = await tx.get(bookingRef);
    if (!s.exists) throw notFound('Booking');
    booking = s.data();
    nightSnaps = await tx.getAll(...nightsBetween(booking.checkIn, booking.checkOut).map((d) => nightRef(booking.roomId, d)));
    if (booking.offerQueueId) queueSnap = await tx.get(db.collection('queue').doc(booking.offerQueueId));
  }

  // Decide what this payment does.
  let action; // 'confirm' | 'relock' | 'balance' | 'invoice' | 'refund'
  let refundReason = null;
  if (invoice) {
    if (['paid', 'void'].includes(invoice.status) || invoice.paidPaise + amountPaise > invoice.totalPaise) {
      action = 'refund';
      refundReason = 'invoice already settled';
    } else action = 'invoice';
  } else if (booking.state === 'held') {
    action = 'confirm';
  } else if (booking.state === 'expired') {
    const free = nightSnaps.every((s) => !s.exists || s.data().bookingId === bookingRef.id);
    action = free ? 'relock' : 'refund';
    refundReason = free ? null : 'paid after the hold expired and the room was taken';
  } else if (['confirmed', 'checked_in'].includes(booking.state) && (booking.paidPaise ?? 0) + amountPaise <= booking.amountPaise) {
    action = 'balance';
  } else {
    action = 'refund';
    refundReason = `booking is ${booking.state}${booking.state === 'confirmed' ? ' and already paid' : ''}`;
  }

  if (payment.isNew && action === 'refund') throw conflict(CODES.INVALID_STATE, `Nothing to collect: ${refundReason}`);
  const receiptPrep = action === 'refund' ? null : await prepareReceipt(tx, { kind: 'receipt', userId: p.userId, booking });

  // ---------------- writes ----------------
  const base = {
    gatewayPaymentId: gatewayPaymentId ?? null,
    method: method ?? p.method ?? null,
    source,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (payment.isNew) tx.create(payment.ref, { ...p, createdAt: FieldValue.serverTimestamp() });

  if (action === 'refund') {
    tx.update(payment.ref, { ...base, status: 'refund_pending', capturedAt: FieldValue.serverTimestamp(), refundReason });
    writeAudit(tx, actor, { action: 'payment.capture', entity: 'payment', entityId: payment.ref.id, before: { status: p.status }, after: { status: 'refund_pending', amountPaise }, reason: refundReason });
    return { status: 'refund_needed', paymentId: payment.ref.id, bookingId: p.bookingId, invoiceId: p.invoiceId, refundReason };
  }

  const receiptData = { actor, paymentId: payment.ref.id, payment: { amountPaise, method: base.method, gateway: p.gateway, gatewayPaymentId }, totalPaise: amountPaise };
  let receipt;
  if (action === 'invoice') {
    const paidPaise = invoice.paidPaise + amountPaise;
    const settled = paidPaise >= invoice.totalPaise;
    tx.update(invoiceRef, { paidPaise, status: settled ? 'paid' : invoice.status, nextReminderAt: settled ? null : invoice.nextReminderAt, paidAt: settled ? FieldValue.serverTimestamp() : null });
    writeAudit(tx, actor, { action: 'invoice.payment', entity: 'invoice', entityId: invoiceRef.id, before: { paidPaise: invoice.paidPaise, status: invoice.status }, after: { paidPaise, status: settled ? 'paid' : invoice.status } });
    receipt = receiptPrep.write({ ...receiptData, bookingId: invoice.bookingId, invoiceId: invoiceRef.id, invoiceNumber: invoice.number, lines: invoice.lines });
  } else {
    const changes = { paidPaise: (booking.paidPaise ?? 0) + amountPaise };
    if (action !== 'balance') Object.assign(changes, { state: 'confirmed', holdExpiresAt: null, confirmedAt: FieldValue.serverTimestamp() });
    tx.update(bookingRef, changes);
    if (action === 'confirm' || action === 'relock') {
      nightsBetween(booking.checkIn, booking.checkOut).forEach((d) =>
        tx.set(nightRef(booking.roomId, d), { roomId: booking.roomId, roomTypeId: booking.roomTypeId, buildingId: booking.buildingId, date: d, bookingId: bookingRef.id, state: 'booked' }),
      );
      writeAudit(tx, actor, { action: 'booking.confirm', entity: 'booking', entityId: bookingRef.id, before: { state: booking.state }, after: { state: 'confirmed', paidPaise: changes.paidPaise }, reason: action === 'relock' ? 'paid after hold expired; nights still free' : null });
    }
    if (queueSnap?.exists && ['offered', 'accepted', 'expired'].includes(queueSnap.data().state)) {
      tx.update(queueSnap.ref, { state: 'accepted', acceptedAt: FieldValue.serverTimestamp() });
    }
    receipt = receiptPrep.write({ ...receiptData, bookingId: bookingRef.id, bookingCode: booking.code });
  }
  tx.update(payment.ref, { ...base, status: 'captured', capturedAt: FieldValue.serverTimestamp(), receiptId: receipt.id });
  writeAudit(tx, actor, { action: 'payment.capture', entity: 'payment', entityId: payment.ref.id, before: { status: p.status }, after: { status: 'captured', amountPaise, method: base.method, receiptId: receipt.id } });
  return { status: 'confirmed', action, paymentId: payment.ref.id, receiptId: receipt.id, receiptNumber: receipt.number, bookingId: p.bookingId ?? invoice?.bookingId ?? null, invoiceId: p.invoiceId ?? null, userId: p.userId };
}

const isContention = (e) => e?.code === 10 || /contention|aborted/i.test(e?.message ?? '');
async function runTx(fn) {
  for (let i = 1; ; i++) {
    try {
      return await db.runTransaction(fn, { maxAttempts: 10 });
    } catch (e) {
      if (!isContention(e) || i >= 5) throw e;
      await new Promise((r) => setTimeout(r, 30 * i));
    }
  }
}

// Gateway payments (verify / webhook / reconcile).
export async function confirmGatewayPayment({ orderId, gatewayPaymentId, amountPaise, method, source, actor }) {
  const result = await runTx(async (tx) => {
    const snap = await findPaymentByOrder(tx, orderId);
    if (!snap) throw notFound('Payment for this order');
    return confirmInTx(tx, { payment: { ref: snap.ref, data: snap.data(), isNew: false }, gatewayPaymentId, amountPaise, method, source, actor });
  });
  return afterConfirm(result, actor);
}

// Cash at the counter: creates the payment and confirms it in one transaction.
export async function confirmCashPayment({ userId, bookingId = null, invoiceId = null, amountPaise, note, actor, recordedBy }) {
  const ref = db.collection('payments').doc();
  const data = { userId, bookingId, invoiceId, gateway: 'cash', orderId: null, gatewayPaymentId: null, amountPaise, method: 'cash', status: 'created', note: note ?? null, recordedBy, idempotencyKey: null, refundedPaise: 0, refunds: [] };
  const result = await runTx((tx) => confirmInTx(tx, { payment: { ref, data, isNew: true }, gatewayPaymentId: null, amountPaise, method: 'cash', source: 'cash', actor }));
  return afterConfirm(result, actor);
}

async function afterConfirm(result, actor) {
  if (result.status === 'refund_needed') {
    await autoRefund(result.paymentId, actor).catch((e) => log.error('autoRefund.failed', { paymentId: result.paymentId, err: e.message }));
  }
  if (result.status === 'confirmed') {
    const user = (await db.collection('users').doc(result.userId).get()).data();
    await sendMail({
      to: user?.email,
      tag: 'receipt',
      subject: `Payment received – receipt ${result.receiptNumber}`,
      text: `Thank you. Your receipt ${result.receiptNumber} is ready: ${appUrl(`/receipts/${result.receiptId}`)}`,
    });
  }
  return result;
}

// Full refund of a payment that could not be applied (e.g. paid after the room was taken).
export async function autoRefund(paymentId, actor) {
  const ref = db.collection('payments').doc(paymentId);
  const p = (await ref.get()).data();
  if (p.status !== 'refund_pending') return;
  let gatewayRefund = null;
  if (p.gateway === 'razorpay') gatewayRefund = await refundPayment(p.gatewayPaymentId, { amountPaise: p.amountPaise, notes: { reason: p.refundReason ?? 'auto refund' } });
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (s.data().status !== 'refund_pending') return;
    const refund = { refundId: gatewayRefund?.id ?? null, amountPaise: p.amountPaise, reason: p.refundReason, status: gatewayRefund ? gatewayRefund.status ?? 'created' : 'manual', at: new Date().toISOString(), by: actor?.uid ?? 'system' };
    tx.update(ref, { status: 'refunded', refundedPaise: p.amountPaise, refunds: FieldValue.arrayUnion(refund) });
    writeAudit(tx, actor, { action: 'payment.refund.auto', entity: 'payment', entityId: ref.id, before: { status: 'refund_pending' }, after: { status: 'refunded', amountPaise: p.amountPaise }, reason: p.refundReason });
  });
  const user = (await db.collection('users').doc(p.userId).get()).data();
  await sendMail({
    to: user?.email,
    tag: 'refund',
    subject: 'Your payment was refunded',
    text: `We could not apply your payment of Rs. ${(p.amountPaise / 100).toFixed(2)} (${p.refundReason}). It has been refunded in full.`,
  });
}

export function assertOwnPayment(user, p) {
  if (!p || p.userId !== user.uid) throw notFound('Payment');
}

export { conflict, unprocessable, CODES };
