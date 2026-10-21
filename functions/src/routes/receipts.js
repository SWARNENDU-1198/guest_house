import { Router } from 'express';
import { z } from 'zod';
import { db } from '../firebase.js';
import { ah, notFound } from '../middleware/errors.js';
import { isStaff } from '../middleware/requireRole.js';
import { validate, zId, zPage } from '../middleware/validate.js';
import { docJSON, paginate } from '../lib/serialize.js';
import { loadReceiptPdf, sendPdf } from '../lib/pdf.js';

export const router = Router();

router.get(
  '/receipts/me',
  validate({ query: z.strictObject({ ...zPage }) }),
  ah(async (req, res) => {
    const col = db.collection('receipts');
    res.json(await paginate(col.where('userId', '==', req.user.uid).orderBy('issuedAt', 'desc'), col, req.q));
  }),
);

async function loadReceipt(req) {
  const snap = await db.collection('receipts').doc(req.params.id).get();
  if (!snap.exists) throw notFound('Receipt');
  const r = snap.data();
  if (r.userId !== req.user.uid && !isStaff(req.user)) throw notFound('Receipt');
  return snap;
}

router.get('/receipts/:id', validate({ params: z.object({ id: zId }) }), ah(async (req, res) => res.json({ receipt: docJSON(await loadReceipt(req)) })));

// GET /receipts/:id/pdf — rendered on request from the frozen snapshot.
router.get(
  '/receipts/:id/pdf',
  validate({ params: z.object({ id: zId }) }),
  ah(async (req, res) => {
    const pdf = await loadReceiptPdf((await loadReceipt(req)).id);
    sendPdf(res, pdf.number, pdf.buffer);
  }),
);
