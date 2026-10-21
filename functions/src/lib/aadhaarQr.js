// Aadhaar Secure QR decoding and verification.
//
// The QR holds a big decimal number. As bytes it is a gzip stream; decompressed,
// it is a series of ISO-8859-1 text fields separated by byte 255, then a JPEG2000
// photo, (in V2+) email/mobile hashes, and finally a 256-byte RSA-SHA256 signature
// over everything before it, made with UIDAI's key.
//
// V2+ QRs start with a version field ("V2", "V3", ...); older QRs do not. After
// that the order is: email/mobile indicator, reference ID, name, DOB, gender, ...
// The first 4 digits of the reference ID are the last 4 digits of the Aadhaar.
//
// Only { last4, name, dob, birthYear, gender } ever leave this module. The photo,
// address and raw payload are dropped as soon as decoding finishes.
import { createHmac, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync, inflateSync, inflateRawSync } from 'node:zlib';
import { unprocessable, CODES } from '../middleware/errors.js';

const DELIM = 255;
const SIG_LEN = 256;
const MAX_DIGITS = 12000;
const MAX_INFLATED = 256 * 1024;

const invalid = (reason, message = 'This is not a valid Aadhaar secure QR') =>
  unprocessable(CODES.INVALID_QR, message, { reason });

const defaultCertPath = fileURLToPath(new URL('../../config/uidai_cert.pem', import.meta.url));

let cachedKey = { path: null, key: null };
function uidaiPublicKey() {
  const path = process.env.UIDAI_CERT_PATH || defaultCertPath;
  if (cachedKey.path === path) return cachedKey.key;
  const key = existsSync(path) ? createPublicKey(readFileSync(path)) : null; // certificate or public key PEM
  cachedKey = { path, key };
  return key;
}

function toBytes(qrData) {
  if (typeof qrData !== 'string' || !/^\d+$/.test(qrData)) throw invalid('NOT_NUMERIC');
  if (qrData.length < 200 || qrData.length > MAX_DIGITS) throw invalid('BAD_LENGTH');
  let hex = BigInt(qrData).toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return Buffer.from(hex, 'hex');
}

function decompress(buf) {
  const opts = { maxOutputLength: MAX_INFLATED };
  for (const fn of [gunzipSync, inflateSync, inflateRawSync]) {
    try {
      return fn(buf, opts);
    } catch {
      /* try the next format */
    }
  }
  throw invalid('NOT_COMPRESSED');
}

function readFields(data, count) {
  const fields = [];
  let start = 0;
  for (let i = 0; i < data.length && fields.length < count; i++) {
    if (data[i] === DELIM) {
      fields.push(data.subarray(start, i).toString('latin1'));
      start = i + 1;
    }
  }
  return fields;
}

function parseDob(dob) {
  const s = (dob || '').trim();
  let m = s.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (m) return { dob: `${m[3]}-${m[2]}-${m[1]}`, birthYear: Number(m[3]) };
  m = s.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
  if (m) return { dob: `${m[1]}-${m[2]}-${m[3]}`, birthYear: Number(m[1]) };
  m = s.match(/^(\d{4})$/);
  if (m) return { dob: m[1], birthYear: Number(m[1]) };
  return null;
}

// Decodes and verifies. Returns { last4, name, dob, birthYear, gender, version, signatureVerified }.
export function decodeSecureQr(qrData) {
  const data = decompress(toBytes(qrData));
  if (data.length <= SIG_LEN + 20) throw invalid('TOO_SHORT');

  const signedData = data.subarray(0, data.length - SIG_LEN);
  const signature = data.subarray(data.length - SIG_LEN);

  const head = readFields(signedData, 7);
  const hasVersion = /^V\d+$/.test(head[0] ?? '');
  const o = hasVersion ? 1 : 0;
  const [refId, name, dobRaw, gender] = [head[o + 1], head[o + 2], head[o + 3], head[o + 4]];
  if (!/^\d{4}\d{8,}$/.test(refId ?? '')) throw invalid('BAD_REFERENCE_ID');
  if (!name || name.length > 120 || !/^[\p{L} .'-]+$/u.test(name)) throw invalid('BAD_NAME');
  const dob = parseDob(dobRaw);
  if (!dob) throw invalid('BAD_DOB');
  if (!['M', 'F', 'T'].includes((gender || '').trim().toUpperCase())) throw invalid('BAD_GENDER');

  const key = uidaiPublicKey();
  let signatureVerified = false;
  if (key) {
    const ok = cryptoVerify('RSA-SHA256', signedData, key, signature);
    if (!ok) throw invalid('BAD_SIGNATURE', 'The QR signature does not match UIDAI. Scan the original QR.');
    signatureVerified = true;
  } else if (process.env.AADHAAR_ALLOW_UNSIGNED !== 'true') {
    // Fail closed: without the UIDAI certificate we cannot trust any QR.
    throw invalid('NO_CERT', 'Aadhaar verification is not configured on the server');
  }

  return {
    last4: refId.slice(0, 4),
    name: name.trim(),
    dob: dob.dob,
    birthYear: dob.birthYear,
    gender: gender.trim().toUpperCase(),
    version: hasVersion ? head[0] : 'V1',
    signatureVerified,
  };
}

const normalize = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

// Case/space-insensitive; a single letter matches a word with that initial
// ("A. Kumar" == "Arun Kumar"). Token order must match.
export function namesMatch(profileName, qrName) {
  const a = normalize(profileName);
  const b = normalize(qrName);
  if (!a.length || a.length !== b.length) return false;
  return a.every((t, i) => {
    const u = b[i];
    if (t === u) return true;
    if (t.length === 1) return u.startsWith(t);
    if (u.length === 1) return t.startsWith(u);
    return false;
  });
}

// One Aadhaar -> one account, without storing the Aadhaar number.
export function refHash(secret, { last4, name, dob }) {
  return createHmac('sha256', secret).update(`${last4}|${normalize(name).join(' ')}|${dob}`).digest('hex');
}
