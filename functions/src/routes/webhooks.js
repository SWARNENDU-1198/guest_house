import { Router } from 'express';
import { createHash } from 'node:crypto';
import { db, FieldValue } from '../firebase.js';
import { ah, ApiError, CODES } from '../middleware/errors.js';
import { writeAudit } from '../lib/audit.js';
import { verifyWebhookSignature } from '../lib/razorpay.js';
import { confirmGatewayPayment, findPaymentByOrder } from '../lib/payments.js';
import { log } from '../lib/log.js';

export const router = Router();

const WEBHOOK_ACTOR = { uid: 'razorpay', role: 'system', ip: null, userAgent: 'razorpay-webhook' };

// POST /webhooks/razorpay — public, but every event must carry a valid
// X-Razorpay-Signature over the raw body. Source of truth for payments.
// Idempotent via webhookEvents/{eventId}.
router.post(
  '/webhooks/razorpay',
  ah(async (req, res) => {
    const raw = req.rawBody;
    const signature = req.get('x-razorpay-signature');
    if (!raw || !verifyWebhookSignature(raw, signature)) {
      log.warn('webhook.bad_signature', { ip: req.ip });
      throw new ApiError(400, CODES.VALIDATION, 'Invalid webhook signature');
    }
    const event = req.body ?? {};
    const eventId = req.get('x-razorpay-event-id') || createHash('sha256').update(raw).digest('hex');
    const evRef = db.collection('webhookEvents').doc(eventId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128));
    const prev = await evRef.get();
    if (prev.exists && prev.data().processed) return res.json({ ok: true, duplicate: true });

    const type = String(event.event ?? '');
    let outcome = 'ignored';
    const payment = event.payload?.payment?.entity;
    if ((type === 'payment.captured' || type === 'order.paid') && payment?.order_id) {
      const r = await confirmGatewayPayment({ orderId: payment.order_id, gatewayPaymentId: payment.id, amountPaise: Number(payment.amount), method: payment.method, source: 'webhook', actor: WEBHOOK_ACTOR });
      outcome = r.status;
    } else if (type === 'payment.failed' && payment?.order_id) {
      await db.runTransaction(async (tx) => {
        const snap = await findPaymentByOrder(tx, payment.order_id);
        if (!snap || snap.data().status !== 'created') return;
        tx.update(snap.ref, { status: 'failed', gatewayPaymentId: payment.id, failureReason: String(payment.error_description ?? payment.error_code ?? 'failed').slice(0, 300), updatedAt: FieldValue.serverTimestamp() });
        writeAudit(tx, WEBHOOK_ACTOR, { action: 'payment.fail', entity: 'payment', entityId: snap.id, before: { status: 'created' }, after: { status: 'failed' } });
      });
      outcome = 'failed';
    } else if (type === 'refund.processed') {
      const refund = event.payload?.refund?.entity;
      const q = await db.collection('payments').where('gatewayPaymentId', '==', refund?.payment_id ?? '-').limit(1).get();
      if (!q.empty) {
        await db.runTransaction(async (tx) => {
          const s = await tx.get(q.docs[0].ref);
          const refunds = (s.data().refunds ?? []).map((r) => (r.refundId === refund.id ? { ...r, status: 'processed' } : r));
          tx.update(s.ref, { refunds });
          writeAudit(tx, WEBHOOK_ACTOR, { action: 'payment.refund.processed', entity: 'payment', entityId: s.id, after: { refundId: refund.id, amountPaise: refund.amount } });
        });
        outcome = 'refund_processed';
      }
    }
    await evRef.set({ type, receivedAt: FieldValue.serverTimestamp(), processed: true, outcome });
    res.json({ ok: true, outcome });
  }),
);
