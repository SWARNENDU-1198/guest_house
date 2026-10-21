import PDFDocument from 'pdfkit';

const inr = (p) => `Rs. ${(Number(p ?? 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Renders a stored snapshot. Same snapshot -> same printed values, always.
export function renderDocument(res, { filename, heading, rows, lines, total, footer }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: heading, Author: 'Guest House' } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  doc.pipe(res);
  doc.fontSize(18).text('Guest House', { align: 'left' });
  doc.fontSize(13).fillColor('#444').text(heading);
  doc.moveDown();
  doc.fillColor('#000').fontSize(10);
  for (const [k, v] of rows) {
    if (v === null || v === undefined || v === '') continue;
    doc.font('Helvetica-Bold').text(`${k}: `, { continued: true }).font('Helvetica').text(String(v));
  }
  if (lines?.length) {
    doc.moveDown().font('Helvetica-Bold').text('Details');
    doc.font('Helvetica');
    for (const l of lines) doc.text(`${l.label}`, { continued: true }).text(`  ${inr(l.amountPaise)}`, { align: 'right' });
  }
  doc.moveDown().font('Helvetica-Bold').fontSize(12).text(`Total: ${inr(total)}`);
  if (footer) doc.moveDown().font('Helvetica').fontSize(8).fillColor('#666').text(footer);
  doc.end();
}

export function renderReceipt(res, receipt) {
  const s = receipt.snapshot;
  const b = s.booking;
  const lines = s.lines ?? (b ? [
    { label: `Room ${b.room} (${b.roomType}), ${b.nights} night(s) x ${inr(b.perNightPaise)}`, amountPaise: b.subtotalPaise },
    ...(b.taxPaise ? [{ label: `Tax ${b.taxPercent}%`, amountPaise: b.taxPaise }] : []),
  ] : []);
  renderDocument(res, {
    filename: `${s.number}.pdf`,
    heading: `${s.title} ${s.number}`,
    rows: [
      ['Issued', s.issuedAt],
      ['Guest', s.guest.name],
      ['Aadhaar', s.guest.aadhaarLast4 ? `XXXX XXXX ${s.guest.aadhaarLast4}` : null],
      ['Booking', b ? `${b.code} · ${b.building}, room ${b.room}` : null],
      ['Stay', b ? `${b.checkIn} to ${b.checkOut} (${b.nights} night(s))` : null],
      ['Invoice', s.invoice?.number],
      ['Payment', s.payment ? `${s.payment.method ?? ''} ${s.payment.gateway ?? ''} ${s.payment.paymentId ?? ''}`.trim() : null],
      ['Note', s.note],
    ],
    lines,
    total: s.totalPaise,
    footer: 'This is a computer-generated document.',
  });
}

export function renderInvoice(res, inv) {
  renderDocument(res, {
    filename: `${inv.number}.pdf`,
    heading: `Invoice ${inv.number}`,
    rows: [
      ['Issued', inv.issuedAt],
      ['Status', inv.status],
      ['Paid so far', inr(inv.paidPaise)],
      ['Balance', inr(inv.totalPaise - inv.paidPaise)],
    ],
    lines: inv.lines,
    total: inv.totalPaise,
    footer: 'Pay online from your dashboard or at the front desk.',
  });
}
