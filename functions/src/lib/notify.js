// Guest-facing emails for booking and payment events, with the PDF attached.
// All are best-effort and run after the transaction commits: a mail failure is
// logged and never fails the request.
import { db } from '../firebase.js';
import { getSettings } from './settings.js';
import { sendMail } from './mailer.js';
import { log } from './log.js';
import { fileSafe } from './counters.js';
import { loadInvoicePdf, loadReceiptPdf } from './pdf.js';
import * as T from './emails.js';

const pdfAttachment = (pdf) => (pdf ? [{ filename: `${fileSafe(pdf.number)}.pdf`, content: pdf.buffer, contentType: 'application/pdf' }] : undefined);

async function userOf(uid) {
  const u = uid ? (await db.collection('users').doc(uid).get()).data() : null;
  return { email: u?.email ?? null, name: u?.aadhaar?.verifiedName || u?.name || 'Guest' };
}

async function bookingView(bookingId) {
  const snap = await db.collection('bookings').doc(bookingId).get();
  if (!snap.exists) return null;
  const b = snap.data();
  const [type, building] = await db.getAll(db.collection('roomTypes').doc(b.roomTypeId), db.collection('buildings').doc(b.buildingId));
  return { id: snap.id, ...b, roomTypeName: type.data()?.name ?? null, buildingName: building.data()?.name ?? null };
}

const safe = (name, fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (e) {
    log.error('notify.failed', { event: name, err: e.message });
    return null;
  }
};

// After createBooking: held -> "pay before …"; confirmed -> slip (free) or invoice (pay later).
export const notifyBookingCreated = safe('booking.created', async (result) => {
  const [org, user, booking] = [(await getSettings()).organisation, await userOf(result.userId), await bookingView(result.id)];
  if (!booking) return;
  if (booking.state === 'held') {
    return sendMail({ to: user.email, tag: 'booking.held', attachments: undefined, ...T.bookingHeld(org, { name: user.name, booking, holdExpiresAt: booking.holdExpiresAt }) });
  }
  if (booking.state !== 'confirmed') return;
  const pdf = result.invoiceId ? await loadInvoicePdf(result.invoiceId) : result.slipId ? await loadReceiptPdf(result.slipId) : null;
  return sendMail({
    to: user.email,
    tag: 'booking.confirmed',
    attachments: pdfAttachment(pdf),
    ...T.bookingConfirmed(org, { name: user.name, booking, how: result.invoiceId ? 'invoice' : 'free', invoiceNumber: pdf?.number }),
  });
});

// After a captured payment (gateway or cash).
export const notifyPaymentConfirmed = safe('payment.confirmed', async (result) => {
  const org = (await getSettings()).organisation;
  const user = await userOf(result.userId);
  const pdf = await loadReceiptPdf(result.receiptId);
  const attachments = pdfAttachment(pdf);
  if (result.bookingId && ['confirm', 'relock'].includes(result.action)) {
    const booking = await bookingView(result.bookingId);
    return sendMail({ to: user.email, tag: 'receipt', attachments, ...T.bookingConfirmed(org, { name: user.name, booking, how: 'paid', receiptNumber: result.receiptNumber }) });
  }
  const receipt = (await db.collection('receipts').doc(result.receiptId).get()).data();
  return sendMail({
    to: user.email,
    tag: 'receipt',
    attachments,
    ...T.paymentReceived(org, { name: user.name, receiptNumber: result.receiptNumber, amountPaise: receipt?.snapshot?.totalPaise ?? 0, invoiceNumber: receipt?.snapshot?.invoice?.number, receiptId: result.receiptId }),
  });
});

export const notifyBookingCancelled = safe('booking.cancelled', async ({ bookingId, refundDuePaise, refundPercent, reason }) => {
  const booking = await bookingView(bookingId);
  const [org, user] = [(await getSettings()).organisation, await userOf(booking.userId)];
  return sendMail({ to: user.email, tag: 'booking.cancelled', ...T.bookingCancelled(org, { name: user.name, booking, refundDuePaise, refundPercent, reason }) });
});

export const notifyRefund = safe('refund', async ({ userId, amountPaise, reason, creditNoteId = null }) => {
  const [org, user] = [(await getSettings()).organisation, await userOf(userId)];
  const pdf = creditNoteId ? await loadReceiptPdf(creditNoteId) : null;
  return sendMail({ to: user.email, tag: 'refund', attachments: pdfAttachment(pdf), ...T.refunded(org, { name: user.name, amountPaise, reason, creditNoteNumber: pdf?.number }) });
});

export async function sendInvoiceReminder({ email, name, inv, invoiceId, n }) {
  const org = (await getSettings()).organisation;
  const pdf = await loadInvoicePdf(invoiceId).catch(() => null);
  return sendMail({ to: email, tag: 'invoice.reminder', attachments: pdfAttachment(pdf), ...T.invoiceReminder(org, { name, inv, invoiceId, n }) });
}

export async function sendInvoiceOverdue({ email, inv }) {
  const org = (await getSettings()).organisation;
  return sendMail({ to: email, tag: 'invoice.overdue', ...T.invoiceOverdue(org, { inv }) });
}

export async function sendQueueOffer(o) {
  const org = (await getSettings()).organisation;
  return sendMail({ to: o.email, tag: 'queue.offer', ...T.queueOffer(org, { o }) });
}

export async function sendQueueMoved({ email, entry, oldPosition, newPosition, reason }) {
  const org = (await getSettings()).organisation;
  return sendMail({ to: email, tag: 'queue.move', ...T.queueMoved(org, { entry, oldPosition, newPosition, reason }) });
}
