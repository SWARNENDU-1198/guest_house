import { z } from 'zod';
import { badRequest } from './errors.js';

const format = (error) =>
  error.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code }));

// validate({ body, query, params }) with zod schemas. Objects should be
// z.strictObject so unknown fields are rejected. Parsed values replace the raw
// ones: req.body, req.q (query), req.params.
export const validate =
  ({ body, query, params } = {}) =>
  (req, res, next) => {
    for (const [key, schema, target] of [
      ['body', body, 'body'],
      ['query', query, 'q'],
      ['params', params, 'params'],
    ]) {
      if (!schema) {
        if (key === 'query') req.q = {};
        continue;
      }
      const input = key === 'body' ? (req.body ?? {}) : req[key];
      const result = schema.safeParse(input);
      if (!result.success) {
        return next(badRequest(`Invalid request ${key}`, { issues: format(result.error) }));
      }
      req[target] = result.data;
    }
    next();
  };

// Common schema pieces
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}, 'Not a real date');
export const zId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, 'Invalid id');
export const zPaise = z.number().int().min(0).max(100_000_000);
export const zReason = z.string().trim().min(3).max(500);
export const zLimit = z.coerce.number().int().min(1).max(100).default(20);
export const zEmpty = z.strictObject({});
export const zPage = { limit: zLimit, cursor: zId.optional() };
