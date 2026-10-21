// Aadhaar OTP verification through a licensed KYC provider (UIDAI only gives
// OTP e-KYC to licensed AUA/KUAs, so a college goes through one of them).
//
// AADHAAR_OTP_PROVIDER:
//   (unset)   disabled: the OTP routes answer NOT_CONFIGURED, QR still works
//   cashfree  Cashfree Secure ID "offline Aadhaar" OTP API
//             CASHFREE_CLIENT_ID (env), CASHFREE_CLIENT_SECRET (secret),
//             CASHFREE_ENV=sandbox|production, CASHFREE_PUBLIC_KEY (PEM, secret;
//             signs each call so no IP whitelist is needed on Cloud Functions)
//   mock      emulator/demo only: OTP 123456, returns the caller's profile name
//
// The full Aadhaar number never leaves this request: only last4 is stored.
import { publicEncrypt, constants } from 'node:crypto';
import { config } from '../config.js';
import { ApiError, unprocessable, CODES } from '../middleware/errors.js';
import { log } from './log.js';

// Verhoeff checksum: the 12th digit of every Aadhaar number.
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1], [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1], [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
export function isValidAadhaarNumber(n) {
  if (!/^[2-9]\d{11}$/.test(n)) return false;
  let c = 0;
  [...n].reverse().forEach((ch, i) => {
    c = D[c][P[i % 8][Number(ch)]];
  });
  return c === 0;
}

const providerError = (message, status = 502) => new ApiError(status, CODES.PROVIDER_ERROR, message);

// --- Cashfree ---------------------------------------------------------------
function cashfree() {
  const base = process.env.CASHFREE_ENV === 'production' ? 'https://api.cashfree.com' : 'https://sandbox.cashfree.com';
  const clientId = process.env.CASHFREE_CLIENT_ID;
  const secret = process.env.CASHFREE_CLIENT_SECRET;
  if (!clientId || !secret) throw new ApiError(503, CODES.NOT_CONFIGURED, 'Aadhaar OTP is not configured on the server');

  const headers = () => {
    const h = { 'content-type': 'application/json', 'x-client-id': clientId, 'x-client-secret': secret };
    const pem = process.env.CASHFREE_PUBLIC_KEY;
    if (pem) {
      const payload = Buffer.from(`${clientId}.${Math.floor(Date.now() / 1000)}`);
      h['x-cf-signature'] = publicEncrypt({ key: pem.replace(/\\n/g, '\n'), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, payload).toString('base64');
    }
    return h;
  };

  async function call(path, body) {
    let res;
    try {
      res = await fetch(`${base}/verification${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      log.error('aadhaarOtp.network', { err: e.message });
      throw providerError('Aadhaar service is not reachable. Try again shortly.');
    }
    const json = await res.json().catch(() => ({}));
    if (res.ok) return json;
    log.warn('aadhaarOtp.error', { status: res.status, code: json.code, message: json.message });
    if (res.status === 400 || res.status === 409) throw unprocessable(CODES.INVALID_STATE, json.message || 'Aadhaar verification failed');
    if (res.status === 429) throw new ApiError(429, CODES.RATE_LIMITED, 'Too many attempts. Wait a minute and try again.');
    throw providerError('Aadhaar verification is temporarily unavailable');
  }

  return {
    name: 'cashfree',
    async sendOtp(aadhaarNumber) {
      const r = await call('/offline-aadhaar/otp', { aadhaar_number: aadhaarNumber });
      if (r.status !== 'SUCCESS' || /not linked/i.test(r.message ?? '')) throw unprocessable(CODES.INVALID_STATE, r.message || 'Could not send the Aadhaar OTP');
      return { providerRef: String(r.ref_id) };
    },
    async verifyOtp(providerRef, otp) {
      const r = await call('/offline-aadhaar/verify', { otp, ref_id: String(providerRef) });
      if (r.status !== 'VALID') throw unprocessable(CODES.OTP_INVALID, r.message || 'Aadhaar OTP could not be verified');
      const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(r.dob ?? '');
      const gender = String(r.gender ?? '').trim().charAt(0).toUpperCase();
      return {
        name: String(r.name ?? '').trim(),
        dob: m ? `${m[3]}-${m[2]}-${m[1]}` : String(r.year_of_birth ?? ''),
        birthYear: Number(m ? m[3] : r.year_of_birth) || null,
        gender: ['M', 'F', 'T'].includes(gender) ? gender : null,
      };
    },
  };
}

// --- mock (emulator / demo) -------------------------------------------------
const MOCK_OTP = '123456';
function mock() {
  if (!config.isEmulator && process.env.AADHAAR_OTP_ALLOW_MOCK !== 'true') throw new ApiError(503, CODES.NOT_CONFIGURED, 'The mock Aadhaar provider only runs on the emulator');
  return {
    name: 'mock',
    async sendOtp() {
      return { providerRef: `mock-${Date.now()}` };
    },
    async verifyOtp(providerRef, otp, { profileName }) {
      if (otp !== MOCK_OTP) throw unprocessable(CODES.OTP_INVALID, 'Aadhaar OTP could not be verified');
      return { name: profileName, dob: '1995-01-01', birthYear: 1995, gender: null };
    },
  };
}

export function aadhaarOtpProvider() {
  const p = process.env.AADHAAR_OTP_PROVIDER;
  if (p === 'cashfree') return cashfree();
  if (p === 'mock') return mock();
  throw new ApiError(503, CODES.NOT_CONFIGURED, 'Aadhaar OTP is not enabled. Use the QR code on your Aadhaar instead.');
}
