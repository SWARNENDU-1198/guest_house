import { Router } from 'express';
import { z } from 'zod';
import { db } from '../firebase.js';
import { ah } from '../middleware/errors.js';
import { requireRole } from '../middleware/requireRole.js';
import { validate, zDate } from '../middleware/validate.js';
import { todayIST, diffDays } from '../lib/dates.js';
import { dateOnlyIN, dateTimeIN } from '../lib/format.js';
import { paymentsBetween, occupancy } from './dashboards.js';

export const router = Router();

const range = (extra = {}) =>
  z
    .strictObject({ from: zDate, to: zDate, ...extra })
    .refine((q) => q.to >= q.from && diffDays(q.from, q.to) <= 366, { message: '"to" must be on/after "from" (max 366 days)', path: ['to'] });

async function categoriesFor(payments) {
  const bookingIds = new Set(payments.map((p) => p.bookingId).filter(Boolean));
  const invoiceIds = [...new Set(payments.map((p) => p.invoiceId).filter(Boolean))];
  const invoices = invoiceIds.length ? await db.getAll(...invoiceIds.map((id) => db.collection('invoices').doc(id))) : [];
  const invBooking = new Map(invoices.map((s) => [s.id, s.data()?.bookingId]));
  invBooking.forEach((b) => b && bookingIds.add(b));
  const ids = [...bookingIds];
  const bookings = ids.length ? await db.getAll(...ids.map((id) => db.collection('bookings').doc(id))) : [];
  const cat = new Map(bookings.map((s) => [s.id, s.data()?.categoryId ?? 'unknown']));
  return (p) => cat.get(p.bookingId ?? invBooking.get(p.invoiceId)) ?? 'unknown';
}

// GET /reports/collections?from&to&groupBy=day|category
router.get(
  '/reports/collections',
  requireRole('accounts', 'admin'),
  validate({ query: range({ groupBy: z.enum(['day', 'category']).default('day') }) }),
  ah(async (req, res) => {
    const { from, to, groupBy } = req.q;
    const payments = await paymentsBetween(from, to);
    const keyOf = groupBy === 'day' ? (p) => todayIST(p.capturedAt.toMillis()) : await categoriesFor(payments);
    const groups = new Map();
    for (const p of payments) {
      const k = keyOf(p);
      const g = groups.get(k) ?? { key: k, count: 0, grossPaise: 0, refundedPaise: 0, netPaise: 0, cashPaise: 0, onlinePaise: 0 };
      g.count += 1;
      g.grossPaise += p.amountPaise;
      g.refundedPaise += p.refundedPaise ?? 0;
      g.netPaise = g.grossPaise - g.refundedPaise;
      if (p.gateway === 'cash') g.cashPaise += p.amountPaise;
      else g.onlinePaise += p.amountPaise;
      groups.set(k, g);
    }
    const rows = [...groups.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
    const total = rows.reduce((t, r) => ({ count: t.count + r.count, grossPaise: t.grossPaise + r.grossPaise, refundedPaise: t.refundedPaise + r.refundedPaise, netPaise: t.netPaise + r.netPaise }), { count: 0, grossPaise: 0, refundedPaise: 0, netPaise: 0 });
    res.json({ from, to, groupBy, rows, total });
  }),
);

// GET /reports/occupancy?from&to — booked nights / available nights per day
router.get(
  '/reports/occupancy',
  requireRole('admin'),
  validate({ query: range() }),
  ah(async (req, res) => res.json({ from: req.q.from, to: req.q.to, ...(await occupancy(req.q.from, req.q.to)) })),
);

// CSV safe for Excel: UTF-8 BOM, CRLF, every field quoted, formula injection neutralised.
export function toCsv(header, rows) {
  const cell = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return `﻿${[header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}

const rs = (p) => (Number(p ?? 0) / 100).toFixed(2);

// GET /reports/payments.csv?from&to
router.get(
  '/reports/payments.csv',
  requireRole('accounts', 'admin'),
  validate({ query: range() }),
  ah(async (req, res) => {
    const payments = (await paymentsBetween(req.q.from, req.q.to)).sort((a, b) => a.capturedAt.toMillis() - b.capturedAt.toMillis());
    const userIds = [...new Set(payments.map((p) => p.userId))];
    const bookingIds = [...new Set(payments.map((p) => p.bookingId).filter(Boolean))];
    const receiptIds = [...new Set(payments.map((p) => p.receiptId).filter(Boolean))];
    const [users, bookings, receipts] = await Promise.all([
      userIds.length ? db.getAll(...userIds.map((id) => db.collection('users').doc(id))) : [],
      bookingIds.length ? db.getAll(...bookingIds.map((id) => db.collection('bookings').doc(id))) : [],
      receiptIds.length ? db.getAll(...receiptIds.map((id) => db.collection('receipts').doc(id))) : [],
    ]);
    const name = new Map(users.map((s) => [s.id, s.data()?.name ?? '']));
    const code = new Map(bookings.map((s) => [s.id, s.data()?.code ?? '']));
    const rnum = new Map(receipts.map((s) => [s.id, s.data()?.number ?? '']));
    const header = ['Date (DD/MM/YYYY)', 'Date & time (IST)', 'Payment ID', 'Receipt', 'Guest', 'Booking', 'Invoice ID', 'Gateway', 'Method', 'Status', 'Amount (INR)', 'Refunded (INR)', 'Gateway payment ID'];
    const rows = payments.map((p) => [
      dateOnlyIN(p.capturedAt),
      dateTimeIN(p.capturedAt),
      p.id,
      rnum.get(p.receiptId) ?? '',
      name.get(p.userId) ?? '',
      code.get(p.bookingId) ?? '',
      p.invoiceId ?? '',
      p.gateway,
      p.method ?? '',
      p.status,
      rs(p.amountPaise),
      rs(p.refundedPaise),
      p.gatewayPaymentId ?? '',
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="payments_${req.q.from}_${req.q.to}.csv"`);
    res.send(toCsv(header, rows));
  }),
);
