import { Router } from 'express';
import { z } from 'zod';
import { db, FieldValue } from '../firebase.js';
import { ah } from '../middleware/errors.js';
import { requireRole } from '../middleware/requireRole.js';
import { validate, zEmpty } from '../middleware/validate.js';
import { writeAudit, actorFrom } from '../lib/audit.js';
import { getSettings, settingsRef, withDefaults } from '../lib/settings.js';
import { toJSON } from '../lib/serialize.js';

export const router = Router();

const settingsPatch = z
  .strictObject({
    holdMinutes: z.number().int().min(1).max(120),
    offerMinutes: z.number().int().min(1).max(24 * 60),
    reminderAfterDays: z.number().int().min(1).max(60),
    reminderEveryDays: z.number().int().min(1).max(60),
    reminderUnit: z.enum(['days', 'minutes']),
    maxReminders: z.number().int().min(1).max(10),
    maxActiveBookings: z.number().int().min(1).max(20),
    officialsQueuePriority: z.boolean(),
    taxPercent: z.number().min(0).max(28),
    refundPolicy: z
      .array(z.strictObject({ hoursBefore: z.number().int().min(0).max(24 * 60), percent: z.number().int().min(0).max(100) }))
      .min(1)
      .max(10),
    organisation: z
      .strictObject({
        name: z.string().trim().min(2).max(120),
        address: z.string().trim().max(300),
        phone: z.string().trim().max(40),
        email: z.union([z.email().max(200), z.literal('')]),
        gstin: z.union([z.string().trim().toUpperCase().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Invalid GSTIN'), z.literal('')]),
        sac: z.string().trim().regex(/^\d{4,8}$/),
      })
      .partial(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

router.get(
  '/settings',
  validate({ query: zEmpty }),
  ah(async (req, res) => res.json({ settings: toJSON(await getSettings()) })),
);

router.patch(
  '/settings',
  requireRole('admin'),
  validate({ body: settingsPatch }),
  ah(async (req, res) => {
    const ref = settingsRef();
    const changes = { ...req.body };
    if (changes.refundPolicy) changes.refundPolicy = [...changes.refundPolicy].sort((a, b) => b.hoursBefore - a.hoursBefore);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const before = withDefaults(snap.data());
      tx.set(ref, { ...changes, updatedAt: FieldValue.serverTimestamp(), updatedBy: req.user.uid }, { merge: true });
      writeAudit(tx, actorFrom(req), {
        action: 'settings.update',
        entity: 'settings',
        entityId: 'global',
        before: Object.fromEntries(Object.keys(changes).map((k) => [k, before[k] ?? null])),
        after: changes,
      });
    });
    res.json({ settings: toJSON(await getSettings()) });
  }),
);
