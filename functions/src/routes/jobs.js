import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ah, forbidden, notFound } from '../middleware/errors.js';
import { requireRole } from '../middleware/requireRole.js';
import { validate } from '../middleware/validate.js';
import { JOBS } from '../jobs/index.js';

// Scheduled jobs normally run as Firebase scheduled functions. These routes let
// an admin trigger one by hand (demo) and let an external cron service call them
// when the API runs on a plain Node host.
export const adminJobs = Router();
adminJobs.post(
  '/admin/jobs/:name/run',
  requireRole('admin'),
  validate({ params: z.object({ name: z.string() }) }),
  ah(async (req, res) => {
    const job = Object.hasOwn(JOBS, req.params.name) ? JOBS[req.params.name] : null;
    if (!job) throw notFound('Job');
    res.json({ job: req.params.name, result: await job() });
  }),
);

const sameSecret = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export const cronJobs = Router();
cronJobs.post(
  '/internal/jobs/:name',
  ah(async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (!secret || secret.length < 16 || !sameSecret(req.get('x-cron-secret') ?? '', secret)) throw forbidden('Bad cron secret');
    const job = Object.hasOwn(JOBS, req.params.name) ? JOBS[req.params.name] : null;
    if (!job) throw notFound('Job');
    res.json({ job: req.params.name, result: await job() });
  }),
);
