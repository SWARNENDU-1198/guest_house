import { Router } from 'express';
import { z } from 'zod';
import { db, Timestamp, AggregateField } from '../firebase.js';
import { ah } from '../middleware/errors.js';
import { requireRole } from '../middleware/requireRole.js';
import { validate } from '../middleware/validate.js';
import { docJSON } from '../lib/serialize.js';
import { todayIST, addDays, istMidnight, nightsBetween } from '../lib/dates.js';
import { getSettings } from '../lib/settings.js';
import { positionOf, waitingFor, ACTIVE_QUEUE_STATES } from '../lib/queue.js';
import { ACTIVE_STATES } from '../lib/booking.js';
import { profileJSON } from './me.js';
import { frontdeskToday } from './frontdesk.js';

export const router = Router();
const noQuery = validate({ query: z.strictObject({}) });

export const COLLECTED = ['captured', 'refund_pending', 'partially_refunded', 'refunded'];
const monthStart = (today) => `${today.slice(0, 7)}-01`;
const ts = (date) => Timestamp.fromDate(istMidnight(date));

// Payments captured in [from, to] (IST dates, inclusive).
export async function paymentsBetween(from, to) {
  const snap = await db.collection('payments').where('capturedAt', '>=', ts(from)).where('capturedAt', '<', ts(addDays(to, 1))).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => COLLECTED.includes(p.status));
}

const sum = (xs, f) => xs.reduce((t, x) => t + (f(x) ?? 0), 0);

async function outstanding() {
  const snap = await db.collection('invoices').where('status', 'in', ['unpaid', 'overdue']).get();
  const items = snap.docs.map((d) => d.data());
  return { totalPaise: sum(items, (i) => i.totalPaise - i.paidPaise), overdueCount: items.filter((i) => i.status === 'overdue').length, unpaidCount: items.length };
}

// Occupancy for [from, to]: booked or occupied nights / available room-nights (active rooms minus blocked nights).
export async function occupancy(from, to) {
  const [rooms, nights] = await Promise.all([
    db.collection('rooms').where('active', '==', true).count().get(),
    db.collection('roomNights').where('date', '>=', from).where('date', '<=', to).get(),
  ]);
  const roomCount = rooms.data().count;
  const byDay = new Map(nightsBetween(from, addDays(to, 1)).map((d) => [d, { date: d, booked: 0, blocked: 0, held: 0 }]));
  for (const n of nights.docs) {
    const { date, state } = n.data();
    const row = byDay.get(date);
    if (!row) continue;
    if (state === 'booked' || state === 'occupied') row.booked += 1;
    else if (state === 'blocked') row.blocked += 1;
    else if (state === 'held') row.held += 1;
  }
  const days = [...byDay.values()].map((r) => {
    const available = roomCount - r.blocked;
    return { ...r, available, occupancyPct: available > 0 ? Math.round((r.booked / available) * 1000) / 10 : 0 };
  });
  const booked = sum(days, (d) => d.booked);
  const available = sum(days, (d) => d.available);
  return { roomCount, days, bookedNights: booked, availableNights: available, occupancyPct: available ? Math.round((booked / available) * 1000) / 10 : 0 };
}

// GET /dashboard/me — guest / official
router.get(
  '/dashboard/me',
  noQuery,
  ah(async (req, res) => {
    const uid = req.user.uid;
    const today = todayIST();
    const [user, bookings, queue, invoices, receipts, settings] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.collection('bookings').where('userId', '==', uid).orderBy('checkIn', 'desc').limit(50).get(),
      db.collection('queue').where('userId', '==', uid).where('state', 'in', [...ACTIVE_QUEUE_STATES, 'accepted']).get(),
      db.collection('invoices').where('userId', '==', uid).where('status', 'in', ['unpaid', 'overdue']).get(),
      db.collection('receipts').where('userId', '==', uid).orderBy('issuedAt', 'desc').limit(5).get(),
      getSettings(),
    ]);
    const all = bookings.docs.map(docJSON);
    const upcoming = all.filter((b) => ACTIVE_STATES.includes(b.state) && b.checkOut >= today).sort((a, b) => (a.checkIn < b.checkIn ? -1 : 1));
    const past = all.filter((b) => !upcoming.includes(b)).slice(0, 10);
    const entries = queue.docs.map(docJSON);
    const types = [...new Set(entries.map((e) => e.roomTypeId))];
    const waiting = Object.fromEntries(await Promise.all(types.map(async (t) => [t, await waitingFor(t)])));
    res.json({
      profile: profileJSON(user),
      verification: { verified: Boolean(user.data()?.aadhaar?.verifiedAt), officialStatus: user.data()?.officialStatus ?? 'none' },
      upcoming,
      past,
      queue: entries.map((e) => ({ ...e, position: e.state === 'waiting' ? positionOf(e, waiting[e.roomTypeId], settings) : null })),
      unpaidInvoices: invoices.docs.map(docJSON).map((i) => ({ ...i, balancePaise: i.totalPaise - i.paidPaise })),
      latestReceipts: receipts.docs.map((d) => ({ id: d.id, number: d.data().number, kind: d.data().kind, totalPaise: d.data().snapshot.totalPaise, issuedAt: d.data().snapshot.issuedAt })),
    });
  }),
);

// GET /dashboard/frontdesk
router.get('/dashboard/frontdesk', requireRole('frontdesk'), noQuery, ah(async (req, res) => res.json(await frontdeskToday())));

// GET /dashboard/accounts
router.get(
  '/dashboard/accounts',
  requireRole('accounts'),
  noQuery,
  ah(async (req, res) => {
    const today = todayIST();
    const [month, out, last] = await Promise.all([
      paymentsBetween(monthStart(today), today),
      outstanding(),
      db.collection('payments').orderBy('createdAt', 'desc').limit(20).get(),
    ]);
    const todays = month.filter((p) => todayIST(p.capturedAt.toMillis()) === today);
    res.json({
      date: today,
      collectedTodayPaise: sum(todays, (p) => p.amountPaise),
      collectedMonthPaise: sum(month, (p) => p.amountPaise),
      refundsMonthPaise: sum(month, (p) => p.refundedPaise),
      outstandingPaise: out.totalPaise,
      unpaidInvoices: out.unpaidCount,
      overdueInvoices: out.overdueCount,
      lastPayments: last.docs.map(docJSON),
    });
  }),
);

// GET /dashboard/admin
router.get(
  '/dashboard/admin',
  requireRole('admin'),
  noQuery,
  ah(async (req, res) => {
    const today = todayIST();
    const ms = monthStart(today);
    const [occToday, occMonth, month, out, queueLen, pendingOfficials, audit, revenueAgg] = await Promise.all([
      occupancy(today, today),
      occupancy(ms, today),
      paymentsBetween(ms, today),
      outstanding(),
      db.collection('queue').where('state', '==', 'waiting').count().get(),
      db.collection('officialRequests').where('status', '==', 'pending').count().get(),
      db.collection('auditLogs').orderBy('at', 'desc').limit(15).get(),
      db.collection('bookings').where('state', 'in', ['confirmed', 'checked_in', 'checked_out']).aggregate({ total: AggregateField.sum('paidPaise') }).get(),
    ]);
    res.json({
      date: today,
      occupancyTodayPct: occToday.occupancyPct,
      occupancyMonthPct: occMonth.occupancyPct,
      revenueMonthPaise: sum(month, (p) => p.amountPaise - (p.refundedPaise ?? 0)),
      bookingRevenueAllTimePaise: revenueAgg.data().total ?? 0,
      outstandingPaise: out.totalPaise,
      overdueInvoices: out.overdueCount,
      queueLength: queueLen.data().count,
      pendingOfficialRequests: pendingOfficials.data().count,
      recentAudit: audit.docs.map(docJSON),
    });
  }),
);
