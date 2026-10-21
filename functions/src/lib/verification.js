import { db, FieldValue } from '../firebase.js';
import { config } from '../config.js';
import { conflict, CODES } from '../middleware/errors.js';
import { refHash } from './aadhaarQr.js';
import { writeAudit } from './audit.js';

export const aadhaarRefFor = (decoded) => db.collection('aadhaarRefs').doc(refHash(config.serverSecret, decoded));

// Reads phase: throws AADHAAR_IN_USE if this Aadhaar belongs to another account.
export async function checkAadhaarFree(tx, uid, decoded) {
  const ref = aadhaarRefFor(decoded);
  const snap = tx ? await tx.get(ref) : await ref.get();
  if (snap.exists && snap.data().uid !== uid) {
    throw conflict(CODES.AADHAAR_IN_USE, 'This Aadhaar is already linked to another account');
  }
  return { ref, exists: snap.exists };
}

// Writes phase: links the Aadhaar to uid and stores only the minimal fields.
export function writeAadhaar(tx, { uid, decoded, refInfo, actor, consentAt, userExists = true }) {
  const aadhaar = {
    last4: decoded.last4,
    verifiedName: decoded.name,
    birthYear: decoded.birthYear,
    method: 'qr',
    signatureVerified: decoded.signatureVerified,
    consentAt,
    verifiedAt: FieldValue.serverTimestamp(),
  };
  if (!refInfo.exists) tx.create(refInfo.ref, { uid, createdAt: FieldValue.serverTimestamp() });
  if (userExists) tx.update(db.collection('users').doc(uid), { aadhaar });
  writeAudit(tx, actor, {
    action: 'user.aadhaar.verify',
    entity: 'user',
    entityId: uid,
    after: { verified: true, method: 'qr', signatureVerified: decoded.signatureVerified },
  });
  return aadhaar;
}
