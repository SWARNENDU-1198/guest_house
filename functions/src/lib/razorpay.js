import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import Razorpay from 'razorpay';

// Real Razorpay (test or live keys) when RAZORPAY_KEY_ID/SECRET are set and
// RAZORPAY_MOCK is not 'true'; otherwise an in-process mock gateway so the whole
// flow works on the emulator without keys. Signature checks are always real HMACs.
const MOCK_KEY_SECRET = 'mock_key_secret_for_local_dev_only';
const MOCK_WEBHOOK_SECRET = 'mock_webhook_secret_for_local_dev_only';

export const isMock = () => process.env.RAZORPAY_MOCK === 'true' || !process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET;
export const keyId = () => (isMock() ? 'rzp_test_mock' : process.env.RAZORPAY_KEY_ID);
const keySecret = () => (isMock() ? process.env.RAZORPAY_KEY_SECRET || MOCK_KEY_SECRET : process.env.RAZORPAY_KEY_SECRET);
const webhookSecret = () => process.env.RAZORPAY_WEBHOOK_SECRET || (isMock() ? MOCK_WEBHOOK_SECRET : null);

let client;
const rzp = () => (client ??= new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET }));

const hmac = (secret, data) => createHmac('sha256', secret).update(data).digest('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
};

// Checkout success handler signature: HMAC_SHA256(key_secret, order_id|payment_id)
export const verifyCheckoutSignature = (orderId, paymentId, signature) => safeEq(hmac(keySecret(), `${orderId}|${paymentId}`), signature);

// Webhook signature: HMAC_SHA256(webhook_secret, raw request body)
export function verifyWebhookSignature(rawBody, signature) {
  const secret = webhookSecret();
  if (!secret || !rawBody || !signature) return false;
  return safeEq(hmac(secret, rawBody), signature);
}

// ---- mock gateway state (per process) ----
const mock = { orders: new Map(), payments: new Map() };
const mockId = (p) => `${p}_mock_${randomBytes(7).toString('hex')}`;

export async function createOrder({ amountPaise, receipt, notes }) {
  if (isMock()) {
    const order = { id: mockId('order'), amount: amountPaise, currency: 'INR', receipt, notes, status: 'created' };
    mock.orders.set(order.id, order);
    return order;
  }
  return rzp().orders.create({ amount: amountPaise, currency: 'INR', receipt, notes });
}

// Returns { id, order_id, amount, status, method } for a payment.
export async function fetchPayment(paymentId, { orderId, amountPaise } = {}) {
  if (isMock()) {
    return mock.payments.get(paymentId) ?? { id: paymentId, order_id: orderId, amount: amountPaise, status: 'captured', method: 'upi' };
  }
  const p = await rzp().payments.fetch(paymentId);
  if (p.status === 'authorized') return rzp().payments.capture(paymentId, p.amount, p.currency);
  return p;
}

// Payments made against an order (used by reconciliation).
export async function fetchOrderPayments(orderId) {
  if (isMock()) return [...mock.payments.values()].filter((p) => p.order_id === orderId);
  const r = await rzp().orders.fetchPayments(orderId);
  return r.items ?? [];
}

export async function refundPayment(paymentId, { amountPaise, notes }) {
  if (isMock()) return { id: mockId('rfnd'), payment_id: paymentId, amount: amountPaise, status: 'processed' };
  return rzp().payments.refund(paymentId, { amount: amountPaise, notes });
}

// ---- test/demo helpers: simulate what Razorpay Checkout + webhooks would send ----
export const mockGateway = {
  pay(orderId, { method = 'upi', status = 'captured', amount } = {}) {
    const order = mock.orders.get(orderId);
    const payment = { id: mockId('pay'), order_id: orderId, amount: amount ?? order?.amount, status, method, currency: 'INR' };
    mock.payments.set(payment.id, payment);
    return { payment, signature: hmac(keySecret(), `${orderId}|${payment.id}`) };
  },
  signWebhook: (rawBody) => hmac(webhookSecret(), rawBody),
  reset() {
    mock.orders.clear();
    mock.payments.clear();
  },
};
