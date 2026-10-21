import PDFDocument from 'pdfkit';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { db } from '../firebase.js';
import { getSettings, DEFAULT_SETTINGS } from './settings.js';
import { fileSafe } from './counters.js';
import { inr, amountInWords, dateIN, dateTimeIN, phoneIN } from './format.js';

// DejaVu Sans has the ₹ glyph (the built-in PDF fonts do not).
const fontDir = join(dirname(createRequire(import.meta.url).resolve('dejavu-fonts-ttf/package.json')), 'ttf');
const FONT = join(fontDir, 'DejaVuSans.ttf');
const BOLD = join(fontDir, 'DejaVuSans-Bold.ttf');

const MUTED = '#555555';
const RULE = '#BBBBBB';
const LEFT = 50;
const RIGHT = 545; // A4 width 595 - 50

const masked = (last4) => (last4 ? `XXXX XXXX ${last4}` : null);

function rule(doc) {
  doc.moveTo(LEFT, doc.y).lineTo(RIGHT, doc.y).strokeColor(RULE).lineWidth(0.7).stroke();
  doc.moveDown(0.5);
}

function header(doc, org, title) {
  doc.font(BOLD).fontSize(16).fillColor('#000').text(org.name || 'Guest House', LEFT, 50, { align: 'center', width: RIGHT - LEFT });
  doc.font(FONT).fontSize(9).fillColor(MUTED);
  if (org.address) doc.text(org.address, { align: 'center', width: RIGHT - LEFT });
  const contact = [org.phone && `Phone: ${org.phone}`, org.email && `Email: ${org.email}`].filter(Boolean).join('   ');
  if (contact) doc.text(contact, { align: 'center', width: RIGHT - LEFT });
  if (org.gstin) doc.text(`GSTIN: ${org.gstin}`, { align: 'center', width: RIGHT - LEFT });
  doc.moveDown(0.6);
  rule(doc);
  doc.font(BOLD).fontSize(13).fillColor('#000').text(title.toUpperCase(), LEFT, doc.y, { align: 'center', width: RIGHT - LEFT, characterSpacing: 1 });
  doc.moveDown(0.6);
}

// Two columns of label: value pairs.
function facts(doc, left, right) {
  const top = doc.y;
  const col = (rows, x, w) => {
    doc.y = top;
    for (const [k, v] of rows) {
      if (v === null || v === undefined || v === '') continue;
      doc.font(BOLD).fontSize(9).fillColor('#000').text(`${k}: `, x, doc.y, { continued: true, width: w }).font(FONT).text(String(v));
    }
    return doc.y;
  };
  const yl = col(left, LEFT, 250);
  const yr = col(right, 310, RIGHT - 310);
  doc.y = Math.max(yl, yr);
  doc.x = LEFT;
  doc.moveDown(0.8);
}

function table(doc, { lines, sac, subtotalPaise, taxPaise, taxPercent, totalPaise, gstin }) {
  const cols = { no: LEFT, desc: LEFT + 30, sac: 380, amt: 440 };
  const row = (cells, { bold = false } = {}) => {
    const y = doc.y;
    doc.font(bold ? BOLD : FONT).fontSize(9).fillColor('#000');
    doc.text(cells[0] ?? '', cols.no, y, { width: 25 });
    doc.text(cells[1] ?? '', cols.desc, y, { width: cols.sac - cols.desc - 10 });
    const h = doc.y;
    doc.text(cells[2] ?? '', cols.sac, y, { width: 55 });
    doc.text(cells[3] ?? '', cols.amt, y, { width: RIGHT - cols.amt, align: 'right' });
    doc.y = Math.max(h, doc.y) + 4;
    doc.x = LEFT;
  };
  rule(doc);
  row(['#', 'Description', sac ? 'SAC' : '', 'Amount'], { bold: true });
  rule(doc);
  lines.forEach((l, i) => row([String(i + 1), l.label, sac ?? '', inr(l.amountPaise)]));
  rule(doc);
  const total = (label, paise, opts) => row(['', '', label, inr(paise)], opts);
  if (taxPaise) {
    total('Sub-total', subtotalPaise);
    // Intra-state supply: GST is split equally into CGST and SGST.
    if (gstin) {
      const cgst = Math.floor(taxPaise / 2);
      total(`CGST ${taxPercent / 2}%`, cgst);
      total(`SGST ${taxPercent / 2}%`, taxPaise - cgst);
    } else total(`Tax ${taxPercent}%`, taxPaise);
  }
  total('Total', totalPaise, { bold: true });
  rule(doc);
  doc.font(BOLD).fontSize(9).text('Amount in words: ', LEFT, doc.y, { continued: true }).font(FONT).text(amountInWords(totalPaise));
  doc.moveDown(0.8);
}

function footer(doc, text) {
  doc.moveDown(1.5);
  doc.font(FONT).fontSize(8).fillColor(MUTED).text(text, LEFT, doc.y, { width: RIGHT - LEFT, align: 'center' });
  doc.text('This is a computer-generated document and does not require a signature.', { width: RIGHT - LEFT, align: 'center' });
}

function toBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

const newDoc = (title) => new PDFDocument({ size: 'A4', margin: 50, info: { Title: title, Author: 'Guest House' } });

// --- receipts, confirmation slips, credit notes (frozen snapshot) -------------
export async function receiptPdf(receipt, settings) {
  const s = receipt.snapshot;
  const b = s.booking;
  const org = s.organisation ?? settings?.organisation ?? DEFAULT_SETTINGS.organisation;
  const lines =
    s.lines ??
    (b ? [{ label: `Room ${b.room} (${b.roomType}), ${b.building}\n${dateIN(b.checkIn)} to ${dateIN(b.checkOut)}: ${b.nights} night(s) × ${inr(b.perNightPaise)}`, amountPaise: b.subtotalPaise }] : []);
  const doc = newDoc(`${s.title} ${s.number}`);
  header(doc, org, s.title);
  facts(
    doc,
    [
      ['Guest', s.guest.name],
      ['Aadhaar', masked(s.guest.aadhaarLast4)],
      ['Mobile', s.guest.phone ? phoneIN(s.guest.phone) : null],
      ['Email', s.guest.email],
    ],
    [
      [{ receipt: 'Receipt No.', slip: 'Slip No.', credit_note: 'Credit Note No.' }[receipt.kind] ?? 'No.', s.number],
      ['Date', dateTimeIN(s.issuedAt)],
      ['Booking ID', b?.code],
      ['Invoice No.', s.invoice?.number],
    ],
  );
  if (b) {
    facts(
      doc,
      [
        ['Check-in', `${dateIN(b.checkIn)}, 12:00 PM`],
        ['Check-out', `${dateIN(b.checkOut)}, 11:00 AM`],
      ],
      [
        ['Room', `${b.room} (${b.roomType})`],
        ['Building', b.building],
      ],
    );
  }
  table(doc, {
    lines,
    sac: org.gstin ? org.sac : null,
    gstin: org.gstin,
    subtotalPaise: b?.subtotalPaise ?? s.totalPaise,
    taxPaise: s.lines ? 0 : (b?.taxPaise ?? 0),
    taxPercent: b?.taxPercent ?? 0,
    totalPaise: s.totalPaise,
  });
  if (s.payment) {
    const mode = s.payment.method === 'cash' ? 'Cash' : `Online${s.payment.method ? ` (${s.payment.method.toUpperCase()})` : ''}`;
    facts(doc, [['Payment mode', mode]], [['Transaction ref.', s.payment.paymentId]]);
  }
  if (s.note) doc.font(FONT).fontSize(9).fillColor('#000').text(`Note: ${s.note}`, LEFT);
  footer(doc, receipt.kind === 'slip' ? 'Please show this slip (printed or on your phone) with your original Aadhaar at the front desk.' : 'Thank you for staying with us.');
  return toBuffer(doc);
}

// --- invoices (live: shows current paid/balance) -----------------------------
export async function invoicePdf(inv, { user, booking, settings }) {
  const org = settings.organisation;
  const taxInvoice = Boolean(org.gstin) && (booking?.rateSnapshot?.taxPaise ?? 0) > 0;
  const doc = newDoc(`Invoice ${inv.number}`);
  header(doc, org, taxInvoice ? 'Tax Invoice' : 'Invoice');
  const status = { unpaid: 'Unpaid', partially_paid: 'Partly paid', paid: 'Paid', overdue: 'Overdue', void: 'Cancelled' }[inv.status] ?? inv.status;
  facts(
    doc,
    [
      ['Billed to', user?.aadhaar?.verifiedName || user?.name],
      ['Aadhaar', masked(user?.aadhaar?.last4)],
      ['Mobile', user?.phone ? phoneIN(user.phone) : null],
      ['Email', user?.email],
    ],
    [
      ['Invoice No.', inv.number],
      ['Invoice date', dateTimeIN(inv.issuedAt)],
      ['Booking ID', booking?.code],
      ['Status', status],
    ],
  );
  const lines = (inv.lines ?? []).map((l) => ({ ...l, label: l.label.replace(/(\d{4})-(\d{2})-(\d{2})/g, (m, y, mo, d) => `${d}/${mo}/${y}`) }));
  table(doc, { lines, sac: org.gstin ? org.sac : null, gstin: org.gstin, subtotalPaise: inv.totalPaise, taxPaise: 0, totalPaise: inv.totalPaise });
  facts(doc, [['Paid so far', inr(inv.paidPaise)]], [['Balance due', inr(inv.totalPaise - inv.paidPaise)]]);
  footer(doc, 'Pay online from your dashboard (UPI / card / net banking) or at the front desk.');
  return toBuffer(doc);
}

// Loads everything an invoice PDF needs.
export async function loadInvoicePdf(invoiceId) {
  const snap = await db.collection('invoices').doc(invoiceId).get();
  if (!snap.exists) return null;
  const inv = snap.data();
  const [user, booking, settings] = await Promise.all([
    db.collection('users').doc(inv.userId).get(),
    inv.bookingId ? db.collection('bookings').doc(inv.bookingId).get() : null,
    getSettings(),
  ]);
  return { number: inv.number, buffer: await invoicePdf(inv, { user: user.data(), booking: booking?.data(), settings }) };
}

export async function loadReceiptPdf(receiptId) {
  const snap = await db.collection('receipts').doc(receiptId).get();
  if (!snap.exists) return null;
  return { number: snap.data().number, kind: snap.data().kind, buffer: await receiptPdf(snap.data(), await getSettings()) };
}

export function sendPdf(res, number, buffer) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${fileSafe(number)}.pdf"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buffer);
}
