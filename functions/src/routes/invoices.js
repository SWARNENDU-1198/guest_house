import { Router } from 'express';
import { z } from 'zod';
import { db, FieldValue } from '../firebase.js';
import { ah, notFound, conflict, CODES } from '../middleware/errors.js';
import { requireRole, isStaff } from '../middleware/requireRole.js';
import { validate, zId, zPaise, zReason, zPage } from '../middleware/validate.js';
import { actorFrom, writeAudit } from '../lib/audit.js';
import { docJSON, toJSON, paginate } from '../lib/serialize.js';
import { prepareInvoice } from '../lib/invoicing.js';
import { getSettings } from '../lib/settings.js';
import { renderInvoice } from '../lib/pdf.js';
import { deliverReminder } from '../jobs/sendReminders.js';

export const router = Router();

const invoiceJSON = (snap) => {
  const inv = docJSON(snap);
  return { ...inv, balancePaise: inv.totalPaise - inv.paidPaise };
};

router.get(
  '/invoices/me',
  validate({ query: z.strictObject({ status: z.enum(['unpaid', 'paid', 'overdue', 'void']).optional(), ...zPage }) }),
  ah(async (req, res) => {
    const col = db.collection('invoices');
    let q = col.where('userId', '==', req.user.uid);
    if (req.q.status) q = q.where('status', '==', req.q.status);
    const page = await paginate(q.orderBy('issuedAt', 'desc'), col, req.q);
    res.json({ items: page.items.map((i) => ({ ...i, balancePaise: i.totalPaise - i.paidPaise })), nextCursor: page.nextCursor });
  }),
);

async function loadInvoice(req) {
  const snap = await db.collection('invoices').doc(req.params.id).get();
  if (!snap.exists || (snap.data().userId !== req.user.uid && !isStaff(req.user))) throw notFound('Invoice');
  return snap;
}

// GET /invoices/:id — details + reminder history
router.get(
  '/invoices/:id',
  validate({ params: z.object({ id: zId }) }),
  ah(async (req, res) => {
    const snap = await loadInvoice(req);
    const reminders = await db.collection('reminders').where('invoiceId', '==', snap.id).get();
    res.json({ invoice: invoiceJSON(snap), reminders: reminders.docs.map(docJSON).sort((a, b) => (a.sentAt < b.sentAt ? -1 : 1)) });
  }),
);

router.get(
  '/invoices/:id/pdf',
  validate({ params: z.object({ id: zId }) }),
  ah(async (req, res) => {
    const snap = await loadInvoice(req);
    renderInvoice(res, toJSON(snap.data()));
  }),
);

// POST /frontdesk/bookings/:id/charges — { lines } creates or extends the booking's charges invoice.
export const chargeLines = z.array(z.strictObject({ label: z.string().trim().min(2).max(120), amountPaise: zPaise.refine((n) => n > 0, 'Must be positive') })).min(1).max(20);

export async function addCharges(tx, { bookingId, lines, actor }) {
  const bookingRef = db.collection('bookings').doc(bookingId);
  const bs = await tx.get(bookingRef);
  if (!bs.exists) throw notFound('Booking');
  const b = bs.data();
  if (!['confirmed', 'checked_in', 'checked_out'].includes(b.state)) throw conflict(CODES.INVALID_STATE, `Cannot add charges to a ${b.state} booking`);
  const open = await tx.get(db.collection('invoices').where('bookingId', '==', bookingId).where('kind', '==', 'charges').where('status', '==', 'unpaid').limit(1));
  const settings = await getSettings(tx);
  const prep = open.empty ? await prepareInvoice(tx) : null;
  if (prep) {
    const id = prep.write({ actor, userId: b.userId, bookingId, lines, settings, kind: 'charges' });
    return { invoiceId: id, created: true };
  }
  const ref = open.docs[0].ref;
  const inv = open.docs[0].data();
  const all = [...inv.lines, ...lines];
  const totalPaise = all.reduce((t, l) => t + l.amountPaise, 0);
  tx.update(ref, { lines: all, totalPaise });
  writeAudit(tx, actor, { action: 'invoice.extend', entity: 'invoice', entityId: ref.id, before: { totalPaise: inv.totalPaise }, after: { totalPaise, added: lines } });
  return { invoiceId: ref.id, created: false };
}

router.post(
  '/frontdesk/bookings/:id/charges',
  requireRole('frontdesk'),
  validate({ params: z.object({ id: zId }), body: z.strictObject({ lines: chargeLines }) }),
  ah(async (req, res) => {
    const r = await db.runTransaction((tx) => addCharges(tx, { bookingId: req.params.id, lines: req.body.lines, actor: actorFrom(req) }));
    res.status(r.created ? 201 : 200).json({ invoice: invoiceJSON(await db.collection('invoices').doc(r.invoiceId).get()) });
  }),
);

// GET /admin/invoices?status=overdue — outstanding list with age in days
router.get(
  '/admin/invoices',
  requireRole('accounts', 'admin'),
  validate({ query: z.strictObject({ status: z.enum(['unpaid', 'paid', 'overdue', 'void']).optional(), ...zPage }) }),
  ah(async (req, res) => {
    const col = db.collection('invoices');
    let q = col;
    if (req.q.status) q = q.where('status', '==', req.q.status);
    const page = await paginate(q.orderBy('issuedAt', 'desc'), col, req.q);
    const now = Date.now();
    res.json({
      items: page.items.map((i) => ({ ...i, balancePaise: i.totalPaise - i.paidPaise, ageDays: i.issuedAt ? Math.floor((now - Date.parse(i.issuedAt)) / 86_400_000) : null })),
      nextCursor: page.nextCursor,
    });
  }),
);

// POST /admin/invoices/:id/remind — send a reminder now (does not change the schedule)
router.post(
  '/admin/invoices/:id/remind',
  requireRole('accounts', 'admin'),
  validate({ params: z.object({ id: zId }), body: z.strictObject({}) }),
  ah(async (req, res) => {
    const ref = db.collection('invoices').doc(req.params.id);
    const reminderRef = db.collection('reminders').doc();
    const { inv, email } = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound('Invoice');
      const i = snap.data();
      if (!['unpaid', 'overdue'].includes(i.status)) throw conflict(CODES.INVALID_STATE, `Invoice is ${i.status}`);
      const user = (await tx.get(db.collection('users').doc(i.userId))).data() ?? {};
      tx.create(reminderRef, { invoiceId: ref.id, userId: i.userId, channel: 'email', sentAt: FieldValue.serverTimestamp(), status: 'sending', error: null, manual: true, sentBy: req.user.uid });
      writeAudit(tx, actorFrom(req), { action: 'invoice.remind.manual', entity: 'invoice', entityId: ref.id });
      return { inv: i, email: user.email };
    });
    const sent = await deliverReminder({ reminderRef, invoiceId: ref.id, inv, email });
    res.json({ sent: sent.ok, reminderId: reminderRef.id });
  }),
);

// POST /admin/invoices/:id/void — { reason }
router.post(
  '/admin/invoices/:id/void',
  requireRole('admin'),
  validate({ params: z.object({ id: zId }), body: z.strictObject({ reason: zReason }) }),
  ah(async (req, res) => {
    const ref = db.collection('invoices').doc(req.params.id);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound('Invoice');
      const i = snap.data();
      if (i.status === 'void') throw conflict(CODES.INVALID_STATE, 'Already void');
      if (i.paidPaise > 0) throw conflict(CODES.INVALID_STATE, 'Invoice has payments; refund them first');
      tx.update(ref, { status: 'void', nextReminderAt: null, voidedBy: req.user.uid, voidReason: req.body.reason, voidedAt: FieldValue.serverTimestamp() });
      writeAudit(tx, actorFrom(req), { action: 'invoice.void', entity: 'invoice', entityId: ref.id, before: { status: i.status }, after: { status: 'void' }, reason: req.body.reason });
    });
    res.json({ invoice: invoiceJSON(await ref.get()) });
  }),
);

// POST /admin/users/:uid/override-overdue — { reason, allow } allow booking despite overdue invoices
router.post(
  '/admin/users/:uid/override-overdue',
  requireRole('admin'),
  validate({ params: z.object({ uid: zId }), body: z.strictObject({ reason: zReason, allow: z.boolean().default(true) }) }),
  ah(async (req, res) => {
    const ref = db.collection('users').doc(req.params.uid);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound('User');
      tx.update(ref, { overdueOverride: req.body.allow });
      writeAudit(tx, actorFrom(req), { action: 'user.overdue.override', entity: 'user', entityId: ref.id, before: { overdueOverride: snap.data().overdueOverride ?? false }, after: { overdueOverride: req.body.allow }, reason: req.body.reason });
    });
    res.json({ uid: ref.id, overdueOverride: req.body.allow });
  }),
);
