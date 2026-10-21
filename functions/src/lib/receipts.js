import { db, FieldValue } from '../firebase.js';
import { writeAudit } from './audit.js';
import { readSeq, formatNumber } from './counters.js';
import { yearIST } from './dates.js';

const KINDS = {
  receipt: { prefix: 'RCPT', counter: 'receipts', title: 'Payment receipt' },
  slip: { prefix: 'SLIP', counter: 'slips', title: 'Confirmation slip' },
  credit_note: { prefix: 'CN', counter: 'creditNotes', title: 'Credit note' },
};

// Read phase: reserves the next number (gap-free: only used if the transaction
// commits) and loads what the printed snapshot needs.
export async function prepareReceipt(tx, { kind = 'receipt', userId, booking: prepared = null }) {
  const k = KINDS[kind];
  const year = yearIST();
  const reads = [db.collection('users').doc(userId)];
  if (prepared) reads.push(db.collection('roomTypes').doc(prepared.roomTypeId), db.collection('buildings').doc(prepared.buildingId));
  const [user, type, building] = await tx.getAll(...reads);
  const seq = await readSeq(tx, `${k.counter}-${year}`);
  const u = user.data() ?? {};
  return {
    write({ booking: bookingOverride = null, actor, bookingId = null, bookingCode = null, paymentId = null, invoiceId = null, invoiceNumber = null, payment = null, lines = null, totalPaise, note = null }) {
      seq.commit();
      const ref = db.collection('receipts').doc();
      const booking = bookingOverride ?? prepared;
      const issuedAt = new Date();
      const snapshot = {
        title: k.title,
        number: formatNumber(k.prefix, year, seq.value),
        issuedAt: issuedAt.toISOString(),
        guest: { name: u.aadhaar?.verifiedName || u.name || '', aadhaarLast4: u.aadhaar?.last4 ?? null, email: u.email ?? null },
        booking: booking
          ? {
              id: bookingId,
              code: bookingCode ?? booking.code,
              room: booking.roomNumber,
              roomType: type?.data()?.name ?? booking.roomTypeId,
              building: building?.data()?.name ?? booking.buildingId,
              checkIn: booking.checkIn,
              checkOut: booking.checkOut,
              nights: booking.nights,
              perNightPaise: booking.rateSnapshot?.perNightPaise ?? 0,
              subtotalPaise: booking.rateSnapshot?.subtotalPaise ?? 0,
              taxPercent: booking.rateSnapshot?.taxPercent ?? 0,
              taxPaise: booking.rateSnapshot?.taxPaise ?? 0,
            }
          : null,
        invoice: invoiceId ? { id: invoiceId, number: invoiceNumber } : null,
        lines,
        totalPaise,
        payment: payment ? { amountPaise: payment.amountPaise, method: payment.method, gateway: payment.gateway, paymentId: payment.gatewayPaymentId ?? paymentId } : null,
        note,
      };
      const doc = { kind, number: snapshot.number, userId, bookingId, paymentId, invoiceId, snapshot, issuedAt: FieldValue.serverTimestamp() };
      tx.create(ref, doc);
      writeAudit(tx, actor, { action: `${kind}.issue`, entity: kind === 'credit_note' ? 'payment' : 'receipt', entityId: kind === 'credit_note' ? paymentId : ref.id, after: { number: snapshot.number, totalPaise, bookingId, invoiceId } });
      return { id: ref.id, number: snapshot.number };
    },
  };
}
