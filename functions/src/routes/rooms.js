import { Router } from 'express';
import { z } from 'zod';
import { db, FieldValue, FieldPath } from '../firebase.js';
import { ah, notFound, conflict, unprocessable, CODES } from '../middleware/errors.js';
import { requireRole } from '../middleware/requireRole.js';
import { validate, zId, zDate, zReason } from '../middleware/validate.js';
import { writeAudit, actorFrom } from '../lib/audit.js';
import { docJSON } from '../lib/serialize.js';
import { nightsBetween, diffDays } from '../lib/dates.js';
import { nightRef } from '../lib/nights.js';
import { releaseNights } from '../lib/release.js';

export const router = Router();

const ROOM_STATUS = ['available', 'cleaning', 'blocked', 'occupied'];
const col = () => db.collection('rooms');

async function checkRefs(tx, { buildingId, roomTypeId }) {
  const [b, t] = await tx.getAll(db.collection('buildings').doc(buildingId), db.collection('roomTypes').doc(roomTypeId));
  if (!b.exists || b.data().active === false) throw unprocessable(CODES.NOT_FOUND, 'Unknown or inactive building');
  if (!t.exists || t.data().active === false) throw unprocessable(CODES.NOT_FOUND, 'Unknown or inactive room type');
}

// GET /rooms?buildingId&roomTypeId&status
router.get(
  '/rooms',
  validate({
    query: z.strictObject({ buildingId: zId.optional(), roomTypeId: zId.optional(), status: z.enum(ROOM_STATUS).optional(), includeInactive: z.enum(['true', 'false']).optional() }),
  }),
  ah(async (req, res) => {
    let q = col();
    for (const k of ['buildingId', 'roomTypeId', 'status']) if (req.q[k]) q = q.where(k, '==', req.q[k]);
    const snap = await q.orderBy(FieldPath.documentId()).get();
    const all = req.q.includeInactive === 'true' && req.user.role === 'admin';
    res.json({ items: snap.docs.map(docJSON).filter((r) => all || r.active !== false) });
  }),
);

router.get(
  '/rooms/:id',
  validate({ params: z.object({ id: zId }) }),
  ah(async (req, res) => {
    const snap = await col().doc(req.params.id).get();
    if (!snap.exists) throw notFound('Room');
    res.json({ item: docJSON(snap) });
  }),
);

router.post(
  '/rooms',
  requireRole('admin'),
  validate({
    body: z.strictObject({
      id: zId.optional(),
      number: z.string().trim().min(1).max(20),
      buildingId: zId,
      roomTypeId: zId,
      floor: z.number().int().min(-5).max(200).default(0),
    }),
  }),
  ah(async (req, res) => {
    const { id, ...data } = req.body;
    const ref = id ? col().doc(id) : col().doc();
    const doc = { ...data, status: 'available', active: true, createdAt: FieldValue.serverTimestamp() };
    await db.runTransaction(async (tx) => {
      await checkRefs(tx, data);
      const dup = await tx.get(col().where('buildingId', '==', data.buildingId).where('number', '==', data.number).limit(1));
      if (!dup.empty) throw conflict(CODES.INVALID_STATE, `Room ${data.number} already exists in this building`);
      if (id && (await tx.get(ref)).exists) throw conflict(CODES.INVALID_STATE, `Room id ${id} already exists`);
      tx.create(ref, doc);
      writeAudit(tx, actorFrom(req), { action: 'room.create', entity: 'room', entityId: ref.id, after: doc });
    });
    res.status(201).json({ item: docJSON(await ref.get()) });
  }),
);

// PATCH /rooms/:id — edit, deactivate. Room type can't change while future nights are held/booked.
router.patch(
  '/rooms/:id',
  requireRole('admin'),
  validate({
    params: z.object({ id: zId }),
    body: z
      .strictObject({
        number: z.string().trim().min(1).max(20).optional(),
        floor: z.number().int().min(-5).max(200).optional(),
        roomTypeId: zId.optional(),
        status: z.enum(['available', 'cleaning']).optional(),
        active: z.boolean().optional(),
      })
      .refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
  }),
  ah(async (req, res) => {
    const ref = col().doc(req.params.id);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound('Room');
      const before = snap.data();
      if (req.body.roomTypeId && req.body.roomTypeId !== before.roomTypeId) {
        await checkRefs(tx, { buildingId: before.buildingId, roomTypeId: req.body.roomTypeId });
        const future = await tx.get(db.collection('roomNights').where('roomId', '==', ref.id).limit(1));
        if (!future.empty) throw unprocessable(CODES.IN_USE, 'Room has held or booked nights; deactivate it and create a new room instead');
      }
      if (req.body.status && before.status === 'occupied') throw unprocessable(CODES.INVALID_STATE, 'Room is occupied; check the guest out first');
      tx.update(ref, { ...req.body, updatedAt: FieldValue.serverTimestamp() });
      writeAudit(tx, actorFrom(req), {
        action: req.body.active === false ? 'room.deactivate' : 'room.update',
        entity: 'room',
        entityId: ref.id,
        before: Object.fromEntries(Object.keys(req.body).map((k) => [k, before[k] ?? null])),
        after: req.body,
      });
    });
    res.json({ item: docJSON(await ref.get()) });
  }),
);

const blockBody = z
  .strictObject({ from: zDate, to: zDate, reason: zReason })
  .refine((b) => b.to > b.from, { message: '"to" must be after "from" (to is exclusive, like checkOut)', path: ['to'] })
  .refine((b) => diffDays(b.from, b.to) <= 180, { message: 'Block at most 180 nights at once', path: ['to'] });

// POST /rooms/:id/block — { from, to (exclusive), reason }
router.post(
  '/rooms/:id/block',
  requireRole('admin'),
  validate({ params: z.object({ id: zId }), body: blockBody }),
  ah(async (req, res) => {
    const roomRef = col().doc(req.params.id);
    const blockRef = roomRef.collection('blocks').doc();
    const dates = nightsBetween(req.body.from, req.body.to);
    await db.runTransaction(async (tx) => {
      const room = await tx.get(roomRef);
      if (!room.exists) throw notFound('Room');
      const refs = dates.map((d) => nightRef(roomRef.id, d));
      const snaps = await tx.getAll(...refs);
      const taken = snaps.filter((s) => s.exists).map((s) => s.data().date);
      if (taken.length) throw conflict(CODES.ROOM_TAKEN, 'Some nights are already held or booked', { dates: taken });
      const block = { roomId: roomRef.id, from: req.body.from, to: req.body.to, reason: req.body.reason, active: true, createdBy: req.user.uid, createdAt: FieldValue.serverTimestamp() };
      tx.create(blockRef, block);
      refs.forEach((r, i) =>
        tx.create(r, { roomId: roomRef.id, roomTypeId: room.data().roomTypeId, buildingId: room.data().buildingId, date: dates[i], bookingId: null, blockId: blockRef.id, state: 'blocked' }),
      );
      writeAudit(tx, actorFrom(req), { action: 'room.block', entity: 'room', entityId: roomRef.id, after: { blockId: blockRef.id, from: block.from, to: block.to }, reason: req.body.reason });
    });
    res.status(201).json({ blockId: blockRef.id, roomId: roomRef.id, from: req.body.from, to: req.body.to, nights: dates.length });
  }),
);

// DELETE /rooms/:id/block/:blockId — unblock; freed nights go to the queue first.
router.delete(
  '/rooms/:id/block/:blockId',
  requireRole('admin'),
  validate({ params: z.object({ id: zId, blockId: zId }) }),
  ah(async (req, res) => {
    const roomRef = col().doc(req.params.id);
    const blockRef = roomRef.collection('blocks').doc(req.params.blockId);
    const result = await db.runTransaction(async (tx) => {
      const [room, block] = await tx.getAll(roomRef, blockRef);
      if (!room.exists) throw notFound('Room');
      if (!block.exists || !block.data().active) throw notFound('Block');
      const b = block.data();
      const refs = nightsBetween(b.from, b.to).map((d) => nightRef(roomRef.id, d));
      const snaps = await tx.getAll(...refs);
      const mine = snaps.filter((s) => s.exists && s.data().blockId === blockRef.id).map((s) => s.data().date);
      const release = await releaseNights(tx, { room: { id: roomRef.id, ...room.data() }, dates: mine, actor: actorFrom(req) });
      tx.update(blockRef, { active: false, removedBy: req.user.uid, removedAt: FieldValue.serverTimestamp() });
      writeAudit(tx, actorFrom(req), { action: 'room.unblock', entity: 'room', entityId: roomRef.id, before: { blockId: blockRef.id, from: b.from, to: b.to }, after: { offers: release.offers.length } });
      return release;
    });
    res.json({ unblocked: true, offers: result.offers });
  }),
);
