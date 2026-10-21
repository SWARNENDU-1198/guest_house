import { Router } from 'express';
import { z } from 'zod';
import { db, Timestamp } from '../firebase.js';
import { ah, forbidden } from '../middleware/errors.js';
import { requireRole } from '../middleware/requireRole.js';
import { validate, zId, zDate, zPage } from '../middleware/validate.js';
import { docJSON, toJSON } from '../lib/serialize.js';
import { istMidnight, addDays, diffDays } from '../lib/dates.js';
import { toCsv } from './reports.js';

// Read-only. There is deliberately no update or delete endpoint for audit entries,
// and security rules deny all client writes.
export const router = Router();

const zEntity = z.string().regex(/^[A-Za-z]+$/).max(40);
const zAction = z.string().regex(/^[A-Za-z.]+$/).max(60);

// Picks one index-backed filter for the query; any others are applied in memory.
function buildQuery({ entity, entityId, actorUid, action, from, to }) {
  let q = db.collection('auditLogs');
  const rest = {};
  if (entity) {
    q = q.where('entity', '==', entity);
    if (entityId) q = q.where('entityId', '==', entityId);
    if (actorUid) rest.actorUid = actorUid;
    if (action) rest.action = action;
  } else if (actorUid) {
    q = q.where('actorUid', '==', actorUid);
    if (action) rest.action = action;
  } else if (action) {
    q = q.where('action', '==', action);
  }
  if (from) q = q.where('at', '>=', Timestamp.fromDate(istMidnight(from)));
  if (to) q = q.where('at', '<', Timestamp.fromDate(istMidnight(addDays(to, 1))));
  return { q: q.orderBy('at', 'desc'), rest };
}

// Accounts may see payment actions only.
const scope = (req) => {
  if (req.user.role === 'accounts') {
    if (req.q.entity && req.q.entity !== 'payment') throw forbidden('Accounts can only view payment audit entries');
    return { ...req.q, entity: 'payment' };
  }
  return req.q;
};

// GET /admin/audit?actorUid&entity&entityId&action&from&to&limit&cursor
router.get(
  '/admin/audit',
  requireRole('admin', 'accounts'),
  validate({
    query: z
      .strictObject({ actorUid: zId.optional(), entity: zEntity.optional(), entityId: zId.optional(), action: zAction.optional(), from: zDate.optional(), to: zDate.optional(), ...zPage })
      .refine((q) => !q.entityId || q.entity, { message: 'entityId needs entity', path: ['entityId'] }),
  }),
  ah(async (req, res) => {
    const f = scope(req);
    const { q, rest } = buildQuery(f);
    const filters = Object.entries(rest);
    let query = q;
    if (f.cursor) {
      const cur = await db.collection('auditLogs').doc(f.cursor).get();
      if (cur.exists) query = query.startAfter(cur);
    }
    // Over-fetch when some filters are applied in memory.
    const batch = await query.limit(filters.length ? f.limit * 10 : f.limit + 1).get();
    const matching = batch.docs.filter((d) => filters.every(([k, v]) => d.data()[k] === v));
    const items = matching.slice(0, f.limit);
    const more = filters.length ? batch.size === f.limit * 10 || matching.length > f.limit : batch.size > f.limit;
    res.json({ items: items.map(docJSON), nextCursor: more && items.length ? items[items.length - 1].id : null });
  }),
);

// GET /admin/audit/:entity/:entityId — full history, oldest first
router.get(
  '/admin/audit/:entity/:entityId',
  requireRole('admin'),
  validate({ params: z.object({ entity: zEntity, entityId: zId }) }),
  ah(async (req, res) => {
    const snap = await db.collection('auditLogs').where('entity', '==', req.params.entity).where('entityId', '==', req.params.entityId).orderBy('at', 'desc').limit(500).get();
    res.json({ entity: req.params.entity, entityId: req.params.entityId, items: snap.docs.map(docJSON).reverse() });
  }),
);

// GET /admin/audit.csv?from&to
router.get(
  '/admin/audit.csv',
  requireRole('admin'),
  validate({
    query: z
      .strictObject({ from: zDate, to: zDate })
      .refine((q) => q.to >= q.from && diffDays(q.from, q.to) <= 366, { message: '"to" must be on/after "from" (max 366 days)', path: ['to'] }),
  }),
  ah(async (req, res) => {
    const { q } = buildQuery(req.q);
    const snap = await q.limit(20000).get();
    const rows = snap.docs.map((d) => {
      const a = toJSON(d.data());
      return [a.at, d.id, a.actorUid, a.actorRole, a.action, a.entity, a.entityId, a.reason ?? '', JSON.stringify(a.before ?? null), JSON.stringify(a.after ?? null), a.ip ?? ''];
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit_${req.q.from}_${req.q.to}.csv"`);
    res.send(toCsv(['At (UTC)', 'Entry ID', 'Actor UID', 'Actor role', 'Action', 'Entity', 'Entity ID', 'Reason', 'Before', 'After', 'IP'], rows));
  }),
);
