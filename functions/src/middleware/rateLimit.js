import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { CODES } from './errors.js';

// Per-user limits (falls back to IP before auth). The default MemoryStore is
// per instance: on Cloud Functions each instance counts separately, which is
// fine at this scale (maxInstances is capped in index.js).
const num = (name, fallback) => Number(process.env[name] ?? fallback);

function limiter(name, limit) {
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `${name}:${req.user?.uid ?? ipKeyGenerator(req.ip ?? '0.0.0.0')}`,
    handler: (req, res) =>
      res.status(429).json({ error: { code: CODES.RATE_LIMITED, message: 'Too many requests, slow down and try again in a minute', details: { limit, windowSeconds: 60 } } }),
  });
}

export function createLimiters({ enabled = process.env.RATE_LIMITS !== 'off' } = {}) {
  const pass = (req, res, next) => next();
  if (!enabled) return { general: pass, aadhaar: pass, booking: pass, webhook: pass };
  return {
    general: limiter('general', num('RATE_LIMIT_GENERAL', 30)),
    aadhaar: limiter('aadhaar', num('RATE_LIMIT_AADHAAR', 5)),
    booking: limiter('booking', num('RATE_LIMIT_BOOKING', 10)),
    webhook: limiter('webhook', num('RATE_LIMIT_WEBHOOK', 300)),
  };
}
