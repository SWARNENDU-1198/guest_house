import { db, FieldValue, Timestamp } from '../firebase.js';
import { writeAudit } from './audit.js';
import { readSeq, formatNumber } from './counters.js';
import { yearIST } from './dates.js';

export const reminderUnitMs = (settings) => (settings.reminderUnit === 'minutes' ? 60_000 : 86_400_000);

// Read phase: reserves the next invoice number. Returns { write(...) } for the write phase.
export async function prepareInvoice(tx) {
  const year = yearIST();
  const seq = await readSeq(tx, `invoices-${year}`);
  return {
    write({ actor, userId, bookingId = null, lines, settings, note = null }) {
      seq.commit();
      const ref = db.collection('invoices').doc();
      const totalPaise = lines.reduce((t, l) => t + l.amountPaise, 0);
      const now = Date.now();
      const invoice = {
        number: formatNumber('INV', year, seq.value),
        userId,
        bookingId,
        lines,
        totalPaise,
        paidPaise: 0,
        status: 'unpaid',
        issuedAt: FieldValue.serverTimestamp(),
        nextReminderAt: Timestamp.fromMillis(now + settings.reminderAfterDays * reminderUnitMs(settings)),
        remindersSent: 0,
        note,
      };
      tx.create(ref, invoice);
      writeAudit(tx, actor, { action: 'invoice.create', entity: 'invoice', entityId: ref.id, after: invoice });
      return ref.id;
    },
  };
}
