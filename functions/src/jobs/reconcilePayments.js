import { db, FieldValue } from '../firebase.js';
import { SYSTEM_ACTOR, writeAudit } from '../lib/audit.js';
import { fetchOrderPayments } from '../lib/razorpay.js';
import { confirmGatewayPayment } from '../lib/payments.js';
import { log } from '../lib/log.js';

const ACTOR = { ...SYSTEM_ACTOR, userAgent: 'reconcile' };

// Every 15 minutes: for Razorpay payments still 'created' (no verify, no webhook),
// ask Razorpay what happened. Captured -> confirm through the normal path
// (re-lock or auto-refund if the hold expired). All attempts failed -> failed.
// Nothing after an hour and the booking is no longer held -> abandoned.
export async function reconcilePayments({ now = Date.now(), minAgeMs = 2 * 60_000, abandonAfterMs = 60 * 60_000 } = {}) {
  const snap = await db.collection('payments').where('status', '==', 'created').limit(200).get();
  const out = { checked: 0, confirmed: 0, failed: 0, abandoned: 0 };
  for (const doc of snap.docs) {
    const p = doc.data();
    if (p.gateway !== 'razorpay' || !p.orderId) continue;
    const age = now - (p.createdAt?.toMillis() ?? now);
    if (age < minAgeMs) continue; // give checkout/webhook time first
    out.checked += 1;
    try {
      const attempts = await fetchOrderPayments(p.orderId);
      const captured = attempts.find((a) => a.status === 'captured');
      if (captured) {
        const r = await confirmGatewayPayment({ orderId: p.orderId, gatewayPaymentId: captured.id, amountPaise: Number(captured.amount), method: captured.method, source: 'reconcile', actor: ACTOR });
        if (['confirmed', 'refund_needed'].includes(r.status)) out.confirmed += 1;
        continue;
      }
      const booking = p.bookingId ? (await db.collection('bookings').doc(p.bookingId).get()).data() : null;
      const stillHeld = booking?.state === 'held';
      if (attempts.length && attempts.every((a) => a.status === 'failed') && !stillHeld) {
        await mark(doc.ref, 'failed', 'all attempts failed');
        out.failed += 1;
      } else if (!attempts.length && age > abandonAfterMs && !stillHeld) {
        await mark(doc.ref, 'abandoned', 'no payment attempt and the hold is over');
        out.abandoned += 1;
      }
    } catch (e) {
      log.error('reconcile.failed', { paymentId: doc.id, err: e.message });
    }
  }
  return out;
}

async function mark(ref, status, reason) {
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (s.data().status !== 'created') return;
    tx.update(ref, { status, updatedAt: FieldValue.serverTimestamp(), reconcileNote: reason });
    writeAudit(tx, ACTOR, { action: `payment.${status}`, entity: 'payment', entityId: ref.id, before: { status: 'created' }, after: { status }, reason });
  });
}
