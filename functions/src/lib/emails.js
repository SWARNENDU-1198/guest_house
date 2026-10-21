// Email templates. Each returns { subject, text, html }; amounts, dates and times
// are in Indian format (₹1,23,456.00, DD/MM/YYYY, IST).
import { inr, inrText, dateIN, dateTimeIN } from './format.js';
import { appUrl } from './mailer.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function layout(org, { heading, intro, rows = [], button, outro }) {
  const table = rows.length
    ? `<table role="presentation" cellpadding="6" cellspacing="0" style="border-collapse:collapse;margin:12px 0;font-size:14px">${rows
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => `<tr><td style="color:#555;padding-right:16px;vertical-align:top">${esc(k)}</td><td style="font-weight:600">${esc(v)}</td></tr>`)
        .join('')}</table>`
    : '';
  const btn = button ? `<p style="margin:20px 0"><a href="${esc(button.href)}" style="background:#1a56db;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">${esc(button.label)}</a></p>` : '';
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#111">
<div style="max-width:560px;margin:0 auto;padding:24px">
<div style="background:#fff;border-radius:8px;padding:24px;border:1px solid #e5e7eb">
<div style="font-size:18px;font-weight:700">${esc(org.name)}</div>
${org.address ? `<div style="font-size:12px;color:#666">${esc(org.address)}</div>` : ''}
<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0">
<h2 style="font-size:18px;margin:0 0 8px">${esc(heading)}</h2>
${intro ? `<p style="font-size:14px;line-height:1.5">${intro}</p>` : ''}
${table}${btn}
${outro ? `<p style="font-size:13px;line-height:1.5;color:#444">${outro}</p>` : ''}
</div>
<p style="font-size:11px;color:#888;text-align:center;margin-top:12px">${esc(org.name)}${org.phone ? ` · ${esc(org.phone)}` : ''}${org.email ? ` · ${esc(org.email)}` : ''}<br>This is an automated message.</p>
</div></body></html>`;
  const strip = (s) =>
    String(s ?? '')
      .replace(/<br\s*\/?>|<\/?div[^>]*>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/\n{2,}/g, '\n')
      .trim();
  const text = [
    org.name,
    '',
    heading,
    intro ? strip(intro) : null,
    '',
    ...rows.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `${k}: ${v}`),
    button ? `\n${button.label}: ${button.href}` : null,
    outro ? `\n${strip(outro)}` : null,
  ]
    .filter((l) => l !== null)
    .join('\n');
  return { html, text };
}

const stayRows = (b, extra = []) => [
  ['Booking ID', b.code],
  ['Room', `${b.roomNumber}${b.roomTypeName ? ` (${b.roomTypeName})` : ''}`],
  ['Building', b.buildingName],
  ['Check-in', `${dateIN(b.checkIn)}, 12:00 PM`],
  ['Check-out', `${dateIN(b.checkOut)}, 11:00 AM`],
  ['Nights', String(b.nights)],
  ...extra,
];

export const emailOtp = (org, { name, code, purpose, minutes }) => ({
  subject: `${org.name}: your verification code`,
  ...layout(org, {
    heading: 'Your one-time password (OTP)',
    intro: `Dear ${esc(name || 'Guest')},<br>Use this code to ${purpose === 'verify_email' ? 'verify your email address' : 'confirm your request'}:` +
      `<div style="font-size:30px;font-weight:700;letter-spacing:8px;margin:16px 0">${esc(code)}</div>It is valid for ${minutes} minutes.`,
    outro: 'Never share this code with anyone. Guest house staff will never ask for it. If you did not request it, ignore this email.',
  }),
});

export const bookingHeld = (org, { name, booking, holdExpiresAt }) => ({
  subject: `Complete your payment – booking ${booking.code}`,
  ...layout(org, {
    heading: 'Your room is on hold',
    intro: `Dear ${esc(name)},<br>We are holding the room below for you. Pay before <b>${esc(dateTimeIN(holdExpiresAt))}</b> to confirm it; after that the hold lapses.`,
    rows: stayRows(booking, [['Amount payable', inr(booking.amountPaise)]]),
    button: { label: 'Pay now', href: appUrl(`/bookings/${booking.id}`) },
  }),
});

export const bookingConfirmed = (org, { name, booking, how, invoiceNumber, receiptNumber }) => ({
  subject: `Booking confirmed – ${booking.code} (${dateIN(booking.checkIn)} to ${dateIN(booking.checkOut)})`,
  ...layout(org, {
    heading: 'Your booking is confirmed',
    intro: `Dear ${esc(name)},<br>${
      how === 'paid' ? `We have received your payment. Your receipt <b>${esc(receiptNumber)}</b> is attached.`
        : how === 'invoice' ? `Your stay is billed to invoice <b>${esc(invoiceNumber)}</b> (attached). Please pay by the due date.`
          : 'This is a complimentary stay. Your confirmation slip is attached.'
    }`,
    rows: stayRows(booking, [['Amount', booking.isFree ? 'Complimentary' : inr(booking.amountPaise)]]),
    button: { label: 'View booking', href: appUrl(`/bookings/${booking.id}`) },
    outro: 'Please carry your original Aadhaar card for check-in at the front desk.',
  }),
});

export const paymentReceived = (org, { name, receiptNumber, amountPaise, invoiceNumber, receiptId }) => ({
  subject: `Payment received – receipt ${receiptNumber} (${inrText(amountPaise)})`,
  ...layout(org, {
    heading: 'Payment received',
    intro: `Dear ${esc(name)},<br>Thank you. We have received ${inr(amountPaise)}${invoiceNumber ? ` against invoice <b>${esc(invoiceNumber)}</b>` : ''}. Your receipt is attached.`,
    rows: [['Receipt No.', receiptNumber], ['Amount', inr(amountPaise)]],
    button: { label: 'View receipt', href: appUrl(`/receipts/${receiptId}`) },
  }),
});

export const bookingCancelled = (org, { name, booking, refundDuePaise, refundPercent, reason }) => ({
  subject: `Booking cancelled – ${booking.code}`,
  ...layout(org, {
    heading: 'Your booking has been cancelled',
    intro: `Dear ${esc(name)},<br>Booking <b>${esc(booking.code)}</b> has been cancelled.${
      refundDuePaise ? ` A refund of <b>${inr(refundDuePaise)}</b> (${refundPercent}%) will be credited to your original payment method within 5–7 working days.` : ''
    }`,
    rows: stayRows(booking, [['Reason', reason], ['Refund', refundDuePaise ? inr(refundDuePaise) : 'Not applicable']]),
  }),
});

export const refunded = (org, { name, amountPaise, reason, creditNoteNumber }) => ({
  subject: `Refund processed – ${inrText(amountPaise)}`,
  ...layout(org, {
    heading: 'Refund processed',
    intro: `Dear ${esc(name)},<br>We have refunded <b>${inr(amountPaise)}</b>${reason ? ` (${esc(reason)})` : ''}. It usually reaches your account in 5–7 working days.`,
    rows: [['Credit note', creditNoteNumber], ['Amount', inr(amountPaise)]],
  }),
});

export const invoiceReminder = (org, { name, inv, invoiceId, n }) => ({
  subject: `Reminder${n ? ` ${n}` : ''}: invoice ${inv.number} – ${inrText(inv.totalPaise - inv.paidPaise)} due`,
  ...layout(org, {
    heading: 'Payment reminder',
    intro: `Dear ${esc(name)},<br>Invoice <b>${esc(inv.number)}</b> has an outstanding balance. Please pay it to avoid a hold on new bookings.`,
    rows: [['Invoice No.', inv.number], ['Invoice date', dateTimeIN(inv.issuedAt)], ['Total', inr(inv.totalPaise)], ['Paid', inr(inv.paidPaise)], ['Balance due', inr(inv.totalPaise - inv.paidPaise)]],
    button: { label: 'Pay now', href: appUrl(`/invoices/${invoiceId}`) },
  }),
});

export const invoiceOverdue = (org, { inv }) => ({
  subject: `Invoice ${inv.number} is overdue`,
  ...layout(org, {
    heading: 'Invoice overdue',
    intro: `Invoice <b>${esc(inv.number)}</b> is now overdue after ${inv.remindersSent} reminder(s). The guest is blocked from new bookings until it is paid.`,
    rows: [['Balance due', inr(inv.totalPaise - inv.paidPaise)]],
  }),
});

export const queueOffer = (org, { o }) => ({
  subject: `A room is available for ${dateIN(o.checkIn)} – accept before ${dateTimeIN(o.expiresAt)}`,
  ...layout(org, {
    heading: 'A room is available for you',
    intro: `Room <b>${esc(o.roomNumber)}</b> is now held for you. Accept before <b>${esc(dateTimeIN(o.expiresAt))}</b> or it goes to the next person in the queue.`,
    rows: [['Check-in', dateIN(o.checkIn)], ['Check-out', dateIN(o.checkOut)], ['Amount', o.amountPaise ? inr(o.amountPaise) : 'Complimentary']],
    button: { label: 'Accept offer', href: appUrl(`/queue/${o.queueId}`) },
  }),
});

export const queueMoved = (org, { entry, oldPosition, newPosition, reason }) => ({
  subject: 'Your place in the room queue changed',
  ...layout(org, {
    heading: 'Queue position changed',
    intro: `Your queue position for ${esc(dateIN(entry.checkIn))} to ${esc(dateIN(entry.checkOut))} moved from ${oldPosition} to ${newPosition}.`,
    rows: [['Reason', reason]],
  }),
});
