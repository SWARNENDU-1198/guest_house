// Builds Aadhaar secure-QR payloads in UIDAI's format, signed with a TEST key
// (the real UIDAI private key is obviously not available). The server is pointed
// at the matching test public key via UIDAI_CERT_PATH.
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const dir = join(tmpdir(), 'guesthouse-test');
mkdirSync(dir, { recursive: true });
export const TEST_CERT_PATH = join(dir, 'test_uidai_public.pem');
writeFileSync(TEST_CERT_PATH, publicKey.export({ type: 'spki', format: 'pem' }));

export function useTestCert() {
  process.env.UIDAI_CERT_PATH = TEST_CERT_PATH;
  delete process.env.AADHAAR_ALLOW_UNSIGNED;
}

export function buildQr({
  last4 = '4321',
  name = 'Asha Verma',
  dob = '15-08-1995',
  gender = 'F',
  version = 'V2',
  signWith = privateKey,
  tamper = null,
  timestamp = String(Date.now()).padEnd(17, '0'),
} = {}) {
  const text = [
    ...(version ? [version] : []),
    '3', // email/mobile indicator
    `${last4}${timestamp}`, // reference id
    name,
    dob,
    gender,
    'D/O Ramesh Verma', 'Pune', 'Near Park', '12', 'Kothrud', '411038', 'Kothrud', 'Maharashtra', 'MG Road', 'Pune', 'Pune',
    ...(version ? ['5678'] : []), // last 4 of mobile (V2+)
  ];
  const parts = [];
  for (const t of text) parts.push(Buffer.from(t, 'latin1'), Buffer.from([255]));
  parts.push(randomBytes(400)); // stand-in for the JPEG2000 photo
  let body = Buffer.concat(parts);
  const signature = sign('RSA-SHA256', body, signWith);
  if (tamper) body = tamper(body);
  const compressed = gzipSync(Buffer.concat([body, signature]));
  return BigInt(`0x${compressed.toString('hex')}`).toString(10);
}

export const otherSigner = otherKey;
