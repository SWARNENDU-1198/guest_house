import { log } from '../lib/log.js';

// Shared error codes (the frontend switches on these).
export const CODES = {
  VALIDATION: 'VALIDATION',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  TOKEN_REVOKED: 'TOKEN_REVOKED',
  NOT_BOOTSTRAPPED: 'NOT_BOOTSTRAPPED',
  UNVERIFIED: 'UNVERIFIED',
  SUSPENDED: 'SUSPENDED',
  ROOM_TAKEN: 'ROOM_TAKEN',
  HOLD_EXPIRED: 'HOLD_EXPIRED',
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  ALREADY_QUEUED: 'ALREADY_QUEUED',
  OFFER_EXPIRED: 'OFFER_EXPIRED',
  OVERDUE_INVOICE: 'OVERDUE_INVOICE',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  INVALID_QR: 'INVALID_QR',
  AADHAAR_IN_USE: 'AADHAAR_IN_USE',
  NOT_FOUND: 'NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
  INVALID_STATE: 'INVALID_STATE',
  IN_USE: 'IN_USE',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
};

export class ApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new ApiError(400, CODES.VALIDATION, message, details);
export const unauthenticated = (message = 'Sign in required', code = CODES.UNAUTHENTICATED) =>
  new ApiError(401, code, message);
export const forbidden = (message = 'You do not have access to this', code = CODES.FORBIDDEN) =>
  new ApiError(403, code, message);
export const notFound = (what = 'Resource') => new ApiError(404, CODES.NOT_FOUND, `${what} not found`);
export const conflict = (code, message, details) => new ApiError(409, code, message, details);
export const unprocessable = (code, message, details) => new ApiError(422, code, message, details);

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: CODES.NOT_FOUND, message: 'No such endpoint', details: {} } });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  // body-parser JSON syntax / size errors
  if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
    return res.status(400).json({ error: { code: CODES.VALIDATION, message: 'Invalid JSON body', details: {} } });
  }
  log.error('unhandled', { path: req.path, method: req.method, err: err?.message, stack: err?.stack });
  res.status(500).json({ error: { code: CODES.INTERNAL, message: 'Something went wrong', details: {} } });
}

// Wrap async route handlers so rejections reach the error handler.
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
