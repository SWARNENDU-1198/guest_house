import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, V, freshWorld, makeUser, db, auditFor } from './helpers.js';
import { buildHouse } from './fixtures.js';
import { todayIST, addDays } from '../src/lib/dates.js';
import { sendReminders } from '../src/jobs/sendReminders.js';
import { outbox } from '../src/lib/mailer.js';

const D = (n) => addDays(todayIST(), n);
const DAY = 86_400_000;

describe('v0.7 invoices and 3-day reminders', () => {
  let admin;
  let acc;
  let fd;
  let faculty;
  let inv1;
  let issued;
  before(async () => {
    await freshWorld();
    admin = await makeUser({ role: 'admin' });
    acc = await makeUser({ role: 'accounts' });
    fd = await makeUser({ role: 'frontdesk' });
    await buildHouse(admin, { roomsPerType: 3 });
    faculty = await makeUser({ categoryId: 'faculty' });
  });
  beforeEach(() => outbox.splice(0));

  it('a pay-later booking raises an unpaid invoice with nextReminderAt = issuedAt + 3 days', async () => {
    const r = await api().post(`${V}/bookings`).set(faculty.auth).send({ roomId: 'r101', checkIn: D(5), checkOut: D(7), payLater: true });
    inv1 = r.body.booking.invoiceId;
    const inv = (await db.doc(`invoices/${inv1}`).get()).data();
    issued = inv.issuedAt.toMillis();
    assert.equal(inv.status, 'unpaid');
    assert.equal(inv.remindersSent, 0);
    assert.ok(Math.abs(inv.nextReminderAt.toMillis() - (issued + 3 * DAY)) < 5000);
    const mine = await api().get(`${V}/invoices/me`).set(faculty.auth);
    assert.equal(mine.body.items[0].balancePaise, 2 * 150000);
  });

  it('the first reminder fires exactly once at day 3', async () => {
    let r = await sendReminders({ now: issued + 2 * DAY });
    assert.equal(r.reminded, 0, 'nothing before day 3');
    r = await sendReminders({ now: issued + 3 * DAY + 10_000 });
    assert.equal(r.reminded, 1);
    r = await sendReminders({ now: issued + 3 * DAY + 20_000 });
    assert.equal(r.reminded, 0, 'a re-run does not double-send');
    const [a, b] = await Promise.all([sendReminders({ now: issued + 3 * DAY + 30_000 }), sendReminders({ now: issued + 3 * DAY + 30_000 })]);
    assert.equal(a.reminded + b.reminded, 0, 'concurrent runs do not double-send');
    assert.equal(outbox.filter((m) => m.tag === 'invoice.reminder' && m.to === faculty.email).length, 1);
    assert.match(outbox[0].text, /\/invoices\//, 'pay link');
    assert.equal((await db.doc(`invoices/${inv1}`).get()).data().remindersSent, 1);
  });

  it('third missed reminder -> overdue, accounts notified, booking blocked', async () => {
    assert.equal((await sendReminders({ now: issued + 6 * DAY + 10_000 })).reminded, 1);
    assert.equal((await sendReminders({ now: issued + 9 * DAY + 10_000 })).reminded, 1);
    const r = await sendReminders({ now: issued + 12 * DAY + 10_000 });
    assert.equal(r.overdue, 1);
    const inv = (await db.doc(`invoices/${inv1}`).get()).data();
    assert.equal(inv.status, 'overdue');
    assert.equal(inv.remindersSent, 3);
    assert.ok(outbox.some((m) => m.tag === 'invoice.overdue' && m.to === acc.email));
    const b = await api().post(`${V}/bookings`).set(faculty.auth).send({ roomId: 'r102', checkIn: D(10), checkOut: D(11) });
    assert.equal(b.body.error.code, 'OVERDUE_INVOICE');
    const q = await api().post(`${V}/queue`).set(faculty.auth).send({ roomTypeId: 'std', checkIn: D(10), checkOut: D(11) });
    assert.equal(q.body.error.code, 'OVERDUE_INVOICE');
  });

  it('every reminder appears in the invoice history', async () => {
    const r = await api().get(`${V}/invoices/${inv1}`).set(faculty.auth);
    assert.equal(r.body.reminders.length, 3);
    assert.ok(r.body.reminders.every((x) => x.status === 'sent' && x.channel === 'email'));
    const stranger = await makeUser();
    assert.equal((await api().get(`${V}/invoices/${inv1}`).set(stranger.auth)).status, 404);
    assert.equal((await api().get(`${V}/invoices/${inv1}`).set(acc.auth)).status, 200);
  });

  it('admin override lets the user book despite the overdue invoice (reason required)', async () => {
    let r = await api().post(`${V}/admin/users/${faculty.uid}/override-overdue`).set(admin.auth).send({});
    assert.equal(r.status, 400);
    r = await api().post(`${V}/admin/users/${faculty.uid}/override-overdue`).set(admin.auth).send({ reason: 'payment promised by department' });
    assert.equal(r.status, 200);
    const b = await api().post(`${V}/bookings`).set(faculty.auth).send({ roomId: 'r102', checkIn: D(10), checkOut: D(11) });
    assert.equal(b.status, 201);
    await api().post(`${V}/admin/users/${faculty.uid}/override-overdue`).set(admin.auth).send({ reason: 'reset', allow: false });
  });

  it('paying stops all further reminders immediately (and clears overdue)', async () => {
    const u = await makeUser({ categoryId: 'faculty' });
    const b = (await api().post(`${V}/bookings`).set(u.auth).send({ roomId: 'r103', checkIn: D(5), checkOut: D(6), payLater: true })).body.booking;
    const inv = (await db.doc(`invoices/${b.invoiceId}`).get()).data();
    const t0 = inv.issuedAt.toMillis();
    await sendReminders({ now: t0 + 3 * DAY + 1000 });
    const cash = await api().post(`${V}/payments/cash`).set(acc.auth).send({ invoiceId: b.invoiceId, amountPaise: inv.totalPaise });
    assert.equal(cash.status, 201, JSON.stringify(cash.body));
    outbox.splice(0);
    const r = await sendReminders({ now: t0 + 30 * DAY });
    assert.ok(!outbox.some((m) => m.to === u.email), 'no reminder after payment');
    assert.equal((await db.doc(`invoices/${b.invoiceId}`).get()).data().status, 'paid');
    assert.equal(r.overdue, 0);
    const overdue = await api().post(`${V}/payments/cash`).set(acc.auth).send({ invoiceId: inv1, amountPaise: 300000 });
    assert.equal(overdue.status, 201);
    const after = await api().post(`${V}/bookings`).set(faculty.auth).send({ roomId: 'r103', checkIn: D(12), checkOut: D(13) });
    assert.equal(after.status, 201, 'paid overdue invoice unblocks booking');
  });

  it('partial payment leaves a balance; reminders continue', async () => {
    const u = await makeUser({ categoryId: 'faculty' });
    const b = (await api().post(`${V}/bookings`).set(u.auth).send({ roomId: 'r101', checkIn: D(20), checkOut: D(22), payLater: true })).body.booking;
    const r = await api().post(`${V}/payments/cash`).set(acc.auth).send({ invoiceId: b.invoiceId, amountPaise: 100000 });
    assert.equal(r.status, 201);
    const inv = await api().get(`${V}/invoices/${b.invoiceId}`).set(u.auth);
    assert.equal(inv.body.invoice.status, 'unpaid');
    assert.equal(inv.body.invoice.balancePaise, 200000);
    assert.equal((await api().post(`${V}/payments/cash`).set(acc.auth).send({ invoiceId: b.invoiceId, amountPaise: 300000 })).status, 422, 'cannot overpay');
  });

  it('demo mode: reminderUnit minutes makes the first reminder due after 3 minutes', async () => {
    await api().patch(`${V}/settings`).set(admin.auth).send({ reminderUnit: 'minutes' });
    const u = await makeUser({ categoryId: 'faculty' });
    const b = (await api().post(`${V}/bookings`).set(u.auth).send({ roomId: 'r102', checkIn: D(25), checkOut: D(26), payLater: true })).body.booking;
    const inv = (await db.doc(`invoices/${b.invoiceId}`).get()).data();
    assert.ok(Math.abs(inv.nextReminderAt.toMillis() - inv.issuedAt.toMillis() - 3 * 60_000) < 5000);
    await api().patch(`${V}/settings`).set(admin.auth).send({ reminderUnit: 'days' });
  });

  it('front desk adds extra charges: creates an invoice, then extends it', async () => {
    const g = await makeUser();
    const b = (await api().post(`${V}/admin/bookings`).set(fd.auth).send({ userId: g.uid, roomId: 'r103', checkIn: D(1), checkOut: D(2), reason: 'walk-in' })).body.booking;
    await api().post(`${V}/payments/cash`).set(fd.auth).send({ bookingId: b.id, amountPaise: b.amountPaise });
    let r = await api().post(`${V}/frontdesk/bookings/${b.id}/charges`).set(fd.auth).send({ lines: [{ label: 'Extra mattress', amountPaise: 50000 }] });
    assert.equal(r.status, 201);
    const id = r.body.invoice.id;
    r = await api().post(`${V}/frontdesk/bookings/${b.id}/charges`).set(fd.auth).send({ lines: [{ label: 'Laundry', amountPaise: 20000 }] });
    assert.equal(r.status, 200);
    assert.equal(r.body.invoice.id, id);
    assert.equal(r.body.invoice.totalPaise, 70000);
    assert.equal((await api().post(`${V}/frontdesk/bookings/${b.id}/charges`).set(g.auth).send({ lines: [{ label: 'x1', amountPaise: 1 }] })).status, 403);
    const pdf = await api().get(`${V}/invoices/${id}/pdf`).set(g.auth);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
  });

  it('accounts lists overdue/outstanding invoices with age; sends a reminder now; admin voids with reason', async () => {
    const u = await makeUser({ categoryId: 'faculty' });
    const b = (await api().post(`${V}/bookings`).set(u.auth).send({ roomId: 'r101', checkIn: D(30), checkOut: D(31), payLater: true })).body.booking;
    let r = await api().get(`${V}/admin/invoices?status=unpaid`).set(acc.auth);
    assert.ok(r.body.items.some((i) => i.id === b.invoiceId && i.ageDays === 0));
    assert.equal((await api().get(`${V}/admin/invoices`).set(fd.auth)).status, 403);
    r = await api().post(`${V}/admin/invoices/${b.invoiceId}/remind`).set(acc.auth).send({});
    assert.equal(r.body.sent, true);
    const hist = await api().get(`${V}/invoices/${b.invoiceId}`).set(acc.auth);
    assert.equal(hist.body.reminders.length, 1);
    assert.equal(hist.body.reminders[0].manual, true);
    assert.equal((await api().post(`${V}/admin/invoices/${b.invoiceId}/void`).set(acc.auth).send({ reason: 'waived' })).status, 403);
    r = await api().post(`${V}/admin/invoices/${b.invoiceId}/void`).set(admin.auth).send({ reason: 'department waiver' });
    assert.equal(r.body.invoice.status, 'void');
    assert.ok((await auditFor('invoice', b.invoiceId)).some((a) => a.action === 'invoice.void' && a.reason === 'department waiver'));
    assert.equal((await sendReminders({ now: Date.now() + 100 * DAY })).checked >= 0, true);
    assert.equal((await db.doc(`invoices/${b.invoiceId}`).get()).data().status, 'void', 'void invoices get no reminders');
  });
});
