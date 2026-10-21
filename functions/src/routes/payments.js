import { Router } from 'express';
import { z } from 'zod';
import { db, FieldValue, Timestamp } from '../firebase.js';
import { ah, notFound, conflict, unprocessable, CODES, ApiError } from '../middleware/errors.js';
import { requireRole } from '../middleware/requireRole.js';
import { validate, zId, zPaise, zReason, zDate, zPage } from '../middleware/validate.js';
import { actorFrom, writeAudit } from '../lib/audit.js';
import { docJSON, paginate } from '../lib/serialize.js';
import { idempotent } from '../lib/idempotency.js';
import { createOrder, keyId, verifyCheckoutSignature, fetchPayment, refundPayment } from '../lib/razorpay.js';
import { confirmGatewayPayment, confirmCashPayment, findPaymentByOrder } from '../lib/payments.js';
import { prepareReceipt } from '../lib/receipts.js';
import { istMidnight, addDays } from '../lib/dates.js';

export const router = Router();

const target = z
  .strictObject({ bookingId: zId.optional(), invoiceId: zId.optional() })
  .refine((b) => Boolean(b.bookingId) !== Boolean(b.invoiceId), { message: 'Send exactly one of bookingId or invoiceId', path: ['bookingId'] });

async function amountDue({ bookingId, invoiceId }, user, { forCash = false } = {}) {
  if (bookingId) {
    const s = await db.collection('bookings').doc(bookingId).get();
    const b = s.data();
    if (!s.exists || (!forCash && b.userId !== user.uid)) throw notFound('Booking');
    if (b.isFree) throw unprocessable(CODES.INVALID_STATE, 'This booking is free; nothing to pay');
    if (b.payLater && b.state === 'confirmed') throw unprocessable(CODES.INVALID_STATE, 'This booking is billed by invoice; pay the invoice');
    if (b.state === 'held') {
      if (!forCash && b.holdExpiresAt.toMillis() <= Date.now()) throw unprocessable(CODES.HOLD_EXPIRED, 'Your hold has expired; book again');
    } else if (!(forCash && ['confirmed', 'checked_in', 'expired'].includes(b.state))) {
      throw unprocessable(b.state === 'expired' ? CODES.HOLD_EXPIRED : CODES.INVALID_STATE, `Booking is ${b.state}`);
    }
    const due = b.amountPaise - (b.paidPaise ?? 0);
    if (due <= 0) throw unprocessable(CODES.INVALID_STATE, 'Nothing is due on this booking');
    return { due, userId: b.userId, booking: b };
  }
  const s = await db.collection('invoices').doc(invoiceId).get();
  const inv = s.data();
  if (!s.exists || (!forCash && inv.userId !== user.uid)) throw notFound('Invoice');
  if (!['unpaid', 'overdue'].includes(inv.status)) throw unprocessable(CODES.INVALID_STATE, `Invoice is ${inv.status}`);
  return { due: inv.totalPaise - inv.paidPaise, userId: inv.userId, invoice: inv };
}

// POST /payments/order — { bookingId } or { invoiceId }. Amount is always computed here.
router.post(
  '/payments/order',
  idempotent(),
  validate({ body: target }),
  ah(async (req, res) => {
    const { due, userId } = await amountDue(req.body, req.user);
    const ref = db.collection('payments').doc();
    const order = await createOrder({ amountPaise: due, receipt: ref.id, notes: { paymentId: ref.id, bookingId: req.body.bookingId ?? '', invoiceId: req.body.invoiceId ?? '', userId } });
    await db.runTransaction(async (tx) => {
      const p = {
        userId,
        bookingId: req.body.bookingId ?? null,
        invoiceId: req.body.invoiceId ?? null,
        gateway: 'razorpay',
        orderId: order.id,
        gatewayPaymentId: null,
        amountPaise: due,
        method: null,
        status: 'created',
        idempotencyKey: req.get('idempotency-key') ?? null,
        recordedBy: req.user.uid,
        refundedPaise: 0,
        refunds: [],
        createdAt: FieldValue.serverTimestamp(),
      };
      tx.create(ref, p);
      writeAudit(tx, actorFrom(req), { action: 'payment.order', entity: 'payment', entityId: ref.id, after: { orderId: order.id, amountPaise: due, bookingId: p.bookingId, invoiceId: p.invoiceId } });
    });
    res.status(201).json({ paymentId: ref.id, orderId: order.id, amount: due, currency: 'INR', keyId: keyId() });
  }),
);

// POST /payments/verify — Checkout success handler fields.
router.post(
  '/payments/verify',
  validate({
    body: z.strictObject({
      razorpay_order_id: z.string().min(1).max(64),
      razorpay_payment_id: z.string().min(1).max(64),
      razorpay_signature: z.string().min(1).max(256),
    }),
  }),
  ah(async (req, res) => {
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body;
    const snap = await findPaymentByOrder(null, orderId);
    if (!snap || snap.data().userId !== req.user.uid) throw notFound('Payment');
    if (!verifyCheckoutSignature(orderId, paymentId, signature)) {
      throw new ApiError(400, CODES.PAYMENT_FAILED, 'Payment signature is invalid');
    }
    const gw = await fetchPayment(paymentId, { orderId, amountPaise: snap.data().amountPaise });
    if (gw.order_id && gw.order_id !== orderId) throw new ApiError(400, CODES.PAYMENT_FAILED, 'Payment does not belong to this order');
    if (gw.status !== 'captured') throw unprocessable(CODES.PAYMENT_FAILED, `Payment is ${gw.status}`);
    const result = await confirmGatewayPayment({ orderId, gatewayPaymentId: paymentId, amountPaise: Number(gw.amount), method: gw.method, source: 'verify', actor: actorFrom(req) });
    res.json(await resultJSON(result));
  }),
);

export async function resultJSON(result) {
  const [booking, receipt, payment] = await Promise.all([
    result.bookingId ? db.collection('bookings').doc(result.bookingId).get() : null,
    result.receiptId ? db.collection('receipts').doc(result.receiptId).get() : null,
    db.collection('payments').doc(result.paymentId).get(),
  ]);
  return {
    status: result.status,
    payment: docJSON(payment),
    booking: booking ? docJSON(booking) : null,
    receipt: receipt ? { id: receipt.id, number: receipt.data().number } : null,
    refunded: ['refund_needed'].includes(result.status),
  };
}

// POST /payments/cash — front desk / accounts record cash at the counter.
router.post(
  '/payments/cash',
  requireRole('frontdesk', 'accounts'),
  idempotent(),
  validate({
    body: z
      .strictObject({ bookingId: zId.optional(), invoiceId: zId.optional(), amountPaise: zPaise.refine((n) => n > 0, 'Must be positive'), note: z.string().trim().max(300).optional() })
      .refine((b) => Boolean(b.bookingId) !== Boolean(b.invoiceId), { message: 'Send exactly one of bookingId or invoiceId', path: ['bookingId'] }),
  }),
  ah(async (req, res) => {
    const { due, userId } = await amountDue(req.body, req.user, { forCash: true });
    if (req.body.bookingId && req.body.amountPaise !== due) throw unprocessable(CODES.INVALID_STATE, `Amount due on this booking is ${due} paise`, { duePaise: due });
    if (req.body.invoiceId && req.body.amountPaise > due) throw unprocessable(CODES.INVALID_STATE, `Only ${due} paise is due on this invoice`, { duePaise: due });
    const result = await confirmCashPayment({ userId, bookingId: req.body.bookingId ?? null, invoiceId: req.body.invoiceId ?? null, amountPaise: req.body.amountPaise, note: req.body.note, actor: actorFrom(req), recordedBy: req.user.uid });
    res.status(201).json(await resultJSON(result));
  }),
);

// POST /payments/:id/refund — { amountPaise, reason } → gateway refund (or manual for cash) + credit note.
router.post(
  '/payments/:id/refund',
  requireRole('accounts', 'admin'),
  idempotent(),
  validate({ params: z.object({ id: zId }), body: z.strictObject({ amountPaise: zPaise.refine((n) => n > 0, 'Must be positive'), reason: zReason }) }),
  ah(async (req, res) => {
    const ref = db.collection('payments').doc(req.params.id);
    const actor = actorFrom(req);
    const { amountPaise, reason } = req.body;
    // 1. reserve the amount so two refunds can't exceed what was paid
    const p = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) throw notFound('Payment');
      const d = s.data();
      if (!['captured', 'partially_refunded'].includes(d.status)) throw conflict(CODES.INVALID_STATE, `Payment is ${d.status}`);
      const left = d.amountPaise - (d.refundedPaise ?? 0);
      if (amountPaise > left) throw unprocessable(CODES.INVALID_STATE, `At most ${left} paise can be refunded`, { refundablePaise: left });
      tx.update(ref, { refundedPaise: (d.refundedPaise ?? 0) + amountPaise, status: 'refund_pending', statusBeforeRefund: d.status });
      return d;
    });
    // 2. gateway call outside the transaction
    let gw = null;
    try {
      if (p.gateway === 'razorpay') gw = await refundPayment(p.gatewayPaymentId, { amountPaise, notes: { reason } });
    } catch (e) {
      await ref.update({ refundedPaise: FieldValue.increment(-amountPaise), status: p.status });
      throw unprocessable(CODES.PAYMENT_FAILED, `Refund failed at the gateway: ${e.message ?? 'error'}`);
    }
    // 3. record + credit note
    const out = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      const d = s.data();
      const booking = d.bookingId ? (await tx.get(db.collection('bookings').doc(d.bookingId))).data() : null;
      const cn = await prepareReceipt(tx, { kind: 'credit_note', userId: d.userId, booking });
      const refund = { refundId: gw?.id ?? null, amountPaise, reason, status: gw ? gw.status ?? 'created' : 'manual', at: new Date().toISOString(), by: req.user.uid };
      const status = d.refundedPaise >= d.amountPaise ? 'refunded' : 'partially_refunded';
      tx.update(ref, { status, refunds: FieldValue.arrayUnion(refund) });
      if (d.bookingId && booking?.refundDuePaise) {
        tx.update(db.collection('bookings').doc(d.bookingId), { refundDuePaise: Math.max(0, booking.refundDuePaise - amountPaise), refundedPaise: FieldValue.increment(amountPaise) });
      }
      writeAudit(tx, actor, { action: 'payment.refund', entity: 'payment', entityId: ref.id, before: { status: p.status, refundedPaise: p.refundedPaise ?? 0 }, after: { status, refundedPaise: d.refundedPaise }, reason });
      const note = cn.write({ actor, bookingId: d.bookingId, paymentId: ref.id, payment: { amountPaise, method: d.method, gateway: d.gateway, gatewayPaymentId: gw?.id ?? null }, totalPaise: amountPaise, lines: [{ label: `Refund: ${reason}`, amountPaise }] });
      return { status, creditNote: note, refund };
    });
    res.json({ payment: docJSON(await ref.get()), creditNote: out.creditNote, refund: out.refund });
  }),
);

// GET /payments?status&from&to — accounts / admin
router.get(
  '/payments',
  requireRole('accounts', 'admin'),
  validate({
    query: z.strictObject({
      status: z.enum(['created', 'captured', 'failed', 'refund_pending', 'refunded', 'partially_refunded', 'mismatch']).optional(),
      from: zDate.optional(),
      to: zDate.optional(),
      ...zPage,
    }),
  }),
  ah(async (req, res) => {
    const col = db.collection('payments');
    let q = col;
    if (req.q.status) q = q.where('status', '==', req.q.status);
    if (req.q.from) q = q.where('createdAt', '>=', Timestamp.fromDate(istMidnight(req.q.from)));
    if (req.q.to) q = q.where('createdAt', '<', Timestamp.fromDate(istMidnight(addDays(req.q.to, 1))));
    res.json(await paginate(q.orderBy('createdAt', 'desc'), col, req.q));
  }),
);

// GET /payments/me
router.get(
  '/payments/me',
  validate({ query: z.strictObject({ ...zPage }) }),
  ah(async (req, res) => {
    const col = db.collection('payments');
    res.json(await paginate(col.where('userId', '==', req.user.uid).orderBy('createdAt', 'desc'), col, req.q));
  }),
);
