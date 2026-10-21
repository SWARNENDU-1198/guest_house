import { db, FieldValue, Timestamp } from '../firebase.js';
import { SYSTEM_ACTOR, writeAudit } from '../lib/audit.js';
import { getSettings } from '../lib/settings.js';
import { reminderUnitMs } from '../lib/invoicing.js';
import { log } from '../lib/log.js';
import { sendInvoiceReminder, sendInvoiceOverdue } from '../lib/notify.js';

// Hourly (every minute in demo mode): remind owners of unpaid invoices.
// The schedule update (remindersSent, nextReminderAt) commits in the same
// transaction that records the reminder, so a retried run never double-sends.
// After maxReminders, the next due run marks the invoice overdue, which blocks
// new bookings (OVERDUE_INVOICE) until paid or an admin overrides.
export async function sendReminders({ now = Date.now(), limit = 200 } = {}) {
  const due = await db
    .collection('invoices')
    .where('status', '==', 'unpaid')
    .where('nextReminderAt', '<=', Timestamp.fromMillis(now))
    .orderBy('nextReminderAt')
    .limit(limit)
    .get();
  const out = { checked: due.size, reminded: 0, overdue: 0 };
  for (const doc of due.docs) {
    try {
      const r = await db.runTransaction(async (tx) => {
        const snap = await tx.get(doc.ref);
        const inv = snap.data();
        if (inv.status !== 'unpaid' || !inv.nextReminderAt || inv.nextReminderAt.toMillis() > now) return null;
        const settings = await getSettings(tx);
        const user = (await tx.get(db.collection('users').doc(inv.userId))).data() ?? {};
        if (inv.remindersSent >= settings.maxReminders) {
          tx.update(doc.ref, { status: 'overdue', nextReminderAt: null, overdueAt: FieldValue.serverTimestamp() });
          writeAudit(tx, SYSTEM_ACTOR, { action: 'invoice.overdue', entity: 'invoice', entityId: doc.id, before: { status: 'unpaid' }, after: { status: 'overdue' }, reason: `${inv.remindersSent} reminders unanswered` });
          return { kind: 'overdue', inv, user };
        }
        const reminderRef = db.collection('reminders').doc();
        tx.create(reminderRef, { invoiceId: doc.id, userId: inv.userId, channel: 'email', sentAt: FieldValue.serverTimestamp(), status: 'sending', error: null, sequence: inv.remindersSent + 1, manual: false });
        tx.update(doc.ref, {
          remindersSent: inv.remindersSent + 1,
          nextReminderAt: Timestamp.fromMillis(inv.nextReminderAt.toMillis() + settings.reminderEveryDays * reminderUnitMs(settings)),
        });
        writeAudit(tx, SYSTEM_ACTOR, { action: 'invoice.remind', entity: 'invoice', entityId: doc.id, after: { remindersSent: inv.remindersSent + 1 } });
        return { kind: 'remind', inv, user, reminderRef, n: inv.remindersSent + 1 };
      });
      if (!r) continue;
      if (r.kind === 'remind') {
        out.reminded += 1;
        await deliverReminder({ reminderRef: r.reminderRef, invoiceId: doc.id, inv: r.inv, email: r.user.email, name: r.user.aadhaar?.verifiedName || r.user.name, n: r.n });
      } else {
        out.overdue += 1;
        await notifyAccounts(doc.id, r.inv);
      }
    } catch (e) {
      log.error('sendReminders.failed', { invoiceId: doc.id, err: e.message });
    }
  }
  return out;
}

export async function deliverReminder({ reminderRef, invoiceId, inv, email, name, n }) {
  const sent = await sendInvoiceReminder({ email, name, inv, invoiceId, n });
  await reminderRef.update({ status: sent.ok ? 'sent' : 'failed', error: sent.ok ? null : String(sent.error).slice(0, 300) });
  return sent;
}

async function notifyAccounts(invoiceId, inv) {
  const staff = await db.collection('users').where('role', 'in', ['accounts']).get();
  for (const s of staff.docs) {
    await sendInvoiceOverdue({ email: s.data().email, inv });
  }
}
