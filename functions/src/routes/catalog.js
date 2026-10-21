import { Router } from 'express';
import { z } from 'zod';
import { db, FieldValue, FieldPath } from '../firebase.js';
import { ah, notFound, conflict, CODES } from '../middleware/errors.js';
import { requireRole } from '../middleware/requireRole.js';
import { validate, zId, zPaise, zDate, zEmpty } from '../middleware/validate.js';
import { writeAudit, actorFrom } from '../lib/audit.js';
import { docJSON } from '../lib/serialize.js';
import { nightsBetween, diffDays } from '../lib/dates.js';
import { priceStay, rateRef, loadCategory } from '../lib/pricing.js';
import { getSettings } from '../lib/settings.js';
import { badRequest } from '../middleware/errors.js';

export const router = Router();

// Generic list / create / edit for small admin-managed collections.
// Nothing here can be deleted, only deactivated (active: false).
function crud({ path, collection, entity, createSchema, patchSchema, allowId = false, validateRefs }) {
  const col = () => db.collection(collection);

  router.get(
    path,
    validate({ query: z.strictObject({ includeInactive: z.enum(['true', 'false']).optional() }) }),
    ah(async (req, res) => {
      const snap = await col().orderBy(FieldPath.documentId()).get();
      const all = req.q.includeInactive === 'true' && req.user.role === 'admin';
      res.json({ items: snap.docs.map(docJSON).filter((d) => all || d.active !== false) });
    }),
  );

  router.post(
    path,
    requireRole('admin'),
    validate({ body: allowId ? createSchema.extend({ id: zId.optional() }) : createSchema }),
    ah(async (req, res) => {
      const { id, ...data } = req.body;
      const ref = id ? col().doc(id) : col().doc();
      const doc = { active: true, ...data, createdAt: FieldValue.serverTimestamp() };
      await db.runTransaction(async (tx) => {
        if (id && (await tx.get(ref)).exists) throw conflict(CODES.INVALID_STATE, `${entity} ${id} already exists`);
        if (validateRefs) await validateRefs(tx, doc);
        tx.create(ref, doc);
        writeAudit(tx, actorFrom(req), { action: `${entity}.create`, entity, entityId: ref.id, after: doc });
      });
      res.status(201).json({ item: docJSON(await ref.get()) });
    }),
  );

  router.patch(
    `${path}/:id`,
    requireRole('admin'),
    validate({ params: z.object({ id: zId }), body: patchSchema.refine((b) => Object.keys(b).length > 0, 'Nothing to update') }),
    ah(async (req, res) => {
      const ref = col().doc(req.params.id);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw notFound(entity);
        const before = snap.data();
        if (validateRefs) await validateRefs(tx, { ...before, ...req.body }, snap);
        tx.update(ref, { ...req.body, updatedAt: FieldValue.serverTimestamp() });
        writeAudit(tx, actorFrom(req), {
          action: req.body.active === false ? `${entity}.deactivate` : `${entity}.update`,
          entity,
          entityId: ref.id,
          before: Object.fromEntries(Object.keys(req.body).map((k) => [k, before[k] ?? null])),
          after: req.body,
        });
      });
      res.json({ item: docJSON(await ref.get()) });
    }),
  );
}

const name = z.string().trim().min(1).max(100);

const building = z.strictObject({ name, address: z.string().trim().max(300).default('') });
crud({ path: '/buildings', collection: 'buildings', entity: 'building', createSchema: building, patchSchema: z.strictObject({ name: name.optional(), address: z.string().trim().max(300).optional(), active: z.boolean().optional() }) });

const roomType = {
  name,
  capacity: z.number().int().min(1).max(20),
  amenities: z.array(z.string().trim().min(1).max(50)).max(30).default([]),
};
crud({
  path: '/room-types',
  collection: 'roomTypes',
  entity: 'roomType',
  allowId: true,
  createSchema: z.strictObject(roomType),
  patchSchema: z.strictObject({ name: name.optional(), capacity: roomType.capacity.optional(), amenities: z.array(z.string().trim().min(1).max(50)).max(30).optional(), active: z.boolean().optional() }),
});

const category = {
  name,
  isFree: z.boolean(),
  maxNights: z.number().int().min(1).max(90),
  maxAdvanceDays: z.number().int().min(0).max(365),
  payLaterAllowed: z.boolean(),
};
crud({
  path: '/categories',
  collection: 'categories',
  entity: 'category',
  allowId: true,
  createSchema: z.strictObject(category),
  patchSchema: z.strictObject({ ...Object.fromEntries(Object.entries(category).map(([k, v]) => [k, v.optional()])), active: z.boolean().optional() }),
});

// GET /rates — full grid category x room type.
router.get(
  '/rates',
  validate({ query: zEmpty }),
  ah(async (req, res) => {
    const [cats, types, rates] = await Promise.all([db.collection('categories').get(), db.collection('roomTypes').get(), db.collection('rates').get()]);
    const byId = new Map(rates.docs.map((d) => [d.id, d.data()]));
    const grid = [];
    for (const c of cats.docs.filter((d) => d.data().active !== false)) {
      for (const t of types.docs.filter((d) => d.data().active !== false)) {
        const r = byId.get(`${c.id}_${t.id}`);
        grid.push({
          categoryId: c.id,
          roomTypeId: t.id,
          amountPaise: c.data().isFree ? 0 : (r?.amountPaise ?? null),
          isFree: Boolean(c.data().isFree),
          effectiveFrom: r?.effectiveFrom?.toDate().toISOString() ?? null,
        });
      }
    }
    res.json({ items: grid });
  }),
);

// PUT /rates/:categoryId/:roomTypeId — { amountPaise }; writes a history row.
router.put(
  '/rates/:categoryId/:roomTypeId',
  requireRole('admin'),
  validate({ params: z.object({ categoryId: zId, roomTypeId: zId }), body: z.strictObject({ amountPaise: zPaise }) }),
  ah(async (req, res) => {
    const { categoryId, roomTypeId } = req.params;
    const ref = rateRef(categoryId, roomTypeId);
    await db.runTransaction(async (tx) => {
      const [cat, type, cur] = await tx.getAll(db.collection('categories').doc(categoryId), db.collection('roomTypes').doc(roomTypeId), ref);
      if (!cat.exists) throw notFound('Category');
      if (!type.exists) throw notFound('Room type');
      const old = cur.exists ? cur.data().amountPaise : null;
      const doc = { categoryId, roomTypeId, amountPaise: req.body.amountPaise, effectiveFrom: FieldValue.serverTimestamp(), updatedBy: req.user.uid };
      tx.set(ref, doc);
      tx.create(ref.collection('history').doc(), { oldAmountPaise: old, newAmountPaise: req.body.amountPaise, changedAt: FieldValue.serverTimestamp(), changedBy: req.user.uid });
      writeAudit(tx, actorFrom(req), { action: 'rate.update', entity: 'rate', entityId: ref.id, before: { amountPaise: old }, after: { amountPaise: req.body.amountPaise } });
    });
    res.json({ item: docJSON(await ref.get()) });
  }),
);

// GET /rates/:categoryId/:roomTypeId/history — Admin, Accounts
router.get(
  '/rates/:categoryId/:roomTypeId/history',
  requireRole('admin', 'accounts'),
  validate({ params: z.object({ categoryId: zId, roomTypeId: zId }) }),
  ah(async (req, res) => {
    const snap = await rateRef(req.params.categoryId, req.params.roomTypeId).collection('history').orderBy('changedAt', 'desc').limit(100).get();
    res.json({ items: snap.docs.map(docJSON) });
  }),
);

export const stayQuery = z
  .strictObject({ roomTypeId: zId, checkIn: zDate, checkOut: zDate })
  .refine((q) => q.checkOut > q.checkIn, { message: 'checkOut must be after checkIn', path: ['checkOut'] })
  .refine((q) => diffDays(q.checkIn, q.checkOut) <= 90, { message: 'Stay too long', path: ['checkOut'] });

// GET /rates/quote?roomTypeId&checkIn&checkOut — price for the caller's category.
router.get(
  '/rates/quote',
  validate({ query: stayQuery }),
  ah(async (req, res) => {
    const { roomTypeId, checkIn, checkOut } = req.q;
    const userSnap = await db.collection('users').doc(req.user.uid).get();
    const categoryId = userSnap.data()?.categoryId ?? req.user.categoryId;
    const [category, type, rate, settings] = await Promise.all([
      loadCategory(null, categoryId),
      db.collection('roomTypes').doc(roomTypeId).get(),
      rateRef(categoryId, roomTypeId).get(),
      getSettings(),
    ]);
    if (!type.exists) throw notFound('Room type');
    const nights = nightsBetween(checkIn, checkOut).length;
    if (nights < 1) throw badRequest('Stay must be at least one night');
    const price = priceStay({ category, rate: rate.exists ? rate.data() : null, nights, taxPercent: settings.taxPercent });
    res.json({ categoryId, roomTypeId, checkIn, checkOut, ...price, maxNights: category.maxNights, withinMaxNights: nights <= category.maxNights });
  }),
);
