import { Router } from 'express';
import { z } from 'zod';
import { db, FieldValue, FieldPath } from '../firebase.js';
import { ah, notFound, conflict, unprocessable, CODES } from '../middleware/errors.js';
import { requireRole } from '../middleware/requireRole.js';
import { validate, zId, zReason, zPage } from '../middleware/validate.js';
import { writeAudit, actorFrom } from '../lib/audit.js';
import { syncClaims } from '../lib/claims.js';
import { ROLES } from '../config.js';
import { profileJSON } from './me.js';
import { docJSON, paginate } from '../lib/serialize.js';

export const router = Router();

// POST /admin/users/:uid/role — set role (claims + doc), revoke tokens, audit.
router.post(
  '/admin/users/:uid/role',
  requireRole('admin'),
  validate({ params: z.object({ uid: zId }), body: z.strictObject({ role: z.enum(ROLES), reason: zReason.optional() }) }),
  ah(async (req, res) => {
    const { uid } = req.params;
    if (uid === req.user.uid) throw unprocessable(CODES.FORBIDDEN, 'Admins cannot change their own role');
    const ref = db.collection('users').doc(uid);
    const updated = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound('User');
      const before = snap.data();
      const after = { ...before, role: req.body.role };
      tx.update(ref, { role: req.body.role });
      writeAudit(tx, actorFrom(req), {
        action: 'user.role.change',
        entity: 'user',
        entityId: uid,
        before: { role: before.role },
        after: { role: after.role },
        reason: req.body.reason,
      });
      return after;
    });
    await syncClaims(uid, updated, { revoke: true });
    res.json({ profile: profileJSON(await ref.get()) });
  }),
);

// GET /admin/users?role&status&categoryId&officialStatus&q&limit&cursor
// q matches an exact email or a name prefix.
router.get(
  '/admin/users',
  requireRole('admin'),
  validate({
    query: z.strictObject({
      role: z.enum(ROLES).optional(),
      status: z.enum(['active', 'suspended']).optional(),
      categoryId: zId.optional(),
      officialStatus: z.enum(['none', 'pending', 'approved', 'rejected']).optional(),
      q: z.string().trim().min(1).max(100).optional(),
      ...zPage,
    }),
  }),
  ah(async (req, res) => {
    const col = db.collection('users');
    const { q, limit, cursor, ...filters } = req.q;
    let query = col;
    if (q && q.includes('@')) query = query.where('email', '==', q.toLowerCase());
    else if (q) query = query.where('name', '>=', q).where('name', '<', `${q}`).orderBy('name');
    for (const [k, v] of Object.entries(filters)) if (v !== undefined) query = query.where(k, '==', v);
    if (!q || q.includes('@')) query = query.orderBy(FieldPath.documentId());
    const page = await paginate(query, col, { limit, cursor });
    res.json({ items: page.items.map((u) => profileJSON({ exists: true, id: u.id, data: () => u })), nextCursor: page.nextCursor });
  }),
);

// PATCH /admin/users/:uid — change category, suspend/reactivate. Reason required.
router.patch(
  '/admin/users/:uid',
  requireRole('admin'),
  validate({
    params: z.object({ uid: zId }),
    body: z
      .strictObject({ categoryId: zId.optional(), status: z.enum(['active', 'suspended']).optional(), reason: zReason })
      .refine((b) => b.categoryId || b.status, 'Nothing to update'),
  }),
  ah(async (req, res) => {
    const { uid } = req.params;
    const { reason, ...changes } = req.body;
    if (uid === req.user.uid && changes.status === 'suspended') throw unprocessable(CODES.FORBIDDEN, 'You cannot suspend yourself');
    const ref = db.collection('users').doc(uid);
    const updated = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound('User');
      if (changes.categoryId) {
        const cat = await tx.get(db.collection('categories').doc(changes.categoryId));
        if (!cat.exists || cat.data().active === false) throw unprocessable(CODES.NOT_FOUND, 'Unknown or inactive category');
      }
      const before = snap.data();
      tx.update(ref, changes);
      writeAudit(tx, actorFrom(req), {
        action: changes.status === 'suspended' ? 'user.suspend' : changes.status === 'active' ? 'user.update' : 'user.category.change',
        entity: 'user',
        entityId: uid,
        before: Object.fromEntries(Object.keys(changes).map((k) => [k, before[k] ?? null])),
        after: changes,
        reason,
      });
      return { ...before, ...changes };
    });
    await syncClaims(uid, updated, { revoke: true });
    res.json({ profile: profileJSON(await ref.get()) });
  }),
);

// GET /admin/official-requests?status=pending
router.get(
  '/admin/official-requests',
  requireRole('admin'),
  validate({ query: z.strictObject({ status: z.enum(['pending', 'approved', 'rejected']).optional(), ...zPage }) }),
  ah(async (req, res) => {
    const col = db.collection('officialRequests');
    let query = col;
    if (req.q.status) query = query.where('status', '==', req.q.status);
    res.json(await paginate(query.orderBy(FieldPath.documentId()), col, req.q));
  }),
);

// POST /admin/official-requests/:id/decide — { approve, reason }
router.post(
  '/admin/official-requests/:id/decide',
  requireRole('admin'),
  validate({
    params: z.object({ id: zId }),
    body: z.strictObject({ approve: z.boolean(), reason: zReason.optional() }).refine((b) => b.approve || b.reason, {
      message: 'A reason is required to reject',
      path: ['reason'],
    }),
  }),
  ah(async (req, res) => {
    const reqRef = db.collection('officialRequests').doc(req.params.id);
    const { approve, reason } = req.body;
    const result = await db.runTransaction(async (tx) => {
      const rs = await tx.get(reqRef);
      if (!rs.exists) throw notFound('Request');
      const request = rs.data();
      if (request.status !== 'pending') throw conflict(CODES.INVALID_STATE, `Request already ${request.status}`);
      const userRef = db.collection('users').doc(request.uid);
      const us = await tx.get(userRef);
      if (!us.exists) throw notFound('User');
      const user = us.data();
      const decision = { status: approve ? 'approved' : 'rejected', decidedBy: req.user.uid, decidedAt: FieldValue.serverTimestamp(), reason: reason ?? null };
      tx.update(reqRef, decision);
      const userChanges = approve ? { role: 'official', categoryId: 'official', officialStatus: 'approved' } : { officialStatus: 'rejected' };
      tx.update(userRef, userChanges);
      const actor = actorFrom(req);
      writeAudit(tx, actor, { action: approve ? 'official.approve' : 'official.reject', entity: 'officialRequest', entityId: reqRef.id, before: { status: 'pending' }, after: { status: decision.status }, reason });
      writeAudit(tx, actor, {
        action: 'user.role.change',
        entity: 'user',
        entityId: request.uid,
        before: { role: user.role, categoryId: user.categoryId, officialStatus: user.officialStatus },
        after: { role: user.role, categoryId: user.categoryId, ...userChanges },
        reason: reason ?? (approve ? 'official request approved' : null),
      });
      return { uid: request.uid, user: { ...user, ...userChanges } };
    });
    if (approve) await syncClaims(result.uid, result.user, { revoke: true });
    res.json({ request: docJSON(await reqRef.get()) });
  }),
);
