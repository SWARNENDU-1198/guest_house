// Structured logger that redacts sensitive values. Never log tokens, QR
// payloads, phone numbers or full emails.

const SECRET_KEYS = /^(authorization|token|idtoken|password|qrdata|qr|signature|razorpay_signature|secret|refhash|photo)$/i;

export function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return email;
  const [user, domain] = email.split('@');
  return `${user.slice(0, 2)}***@${domain}`;
}

export function maskPhone(phone) {
  if (typeof phone !== 'string') return phone;
  const digits = phone.replace(/\D/g, '');
  return digits.length <= 2 ? '**' : `******${digits.slice(-2)}`;
}

export function redact(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value;
  if (typeof value === 'string') {
    // Long digit runs (Aadhaar / QR payloads / phone numbers) are cut down.
    if (/\d{10,}/.test(value)) return value.replace(/\d{10,}/g, (m) => `[${m.length} digits]`);
    if (/^[^@\s]+@[^@\s]+$/.test(value)) return maskEmail(value);
    if (/^Bearer\s/i.test(value)) return 'Bearer [redacted]';
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.test(k)) out[k] = '[redacted]';
      else if (/^phone$/i.test(k)) out[k] = maskPhone(v);
      else if (/^email$/i.test(k)) out[k] = maskEmail(v);
      else out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

const write = (level, msg, data) => {
  if (process.env.LOG_SILENT === 'true' && level !== 'error') return;
  const line = JSON.stringify({ severity: level.toUpperCase(), message: msg, ...redact(data ?? {}) });
  if (level === 'error') console.error(line);
  else console.log(line);
};

export const log = {
  info: (msg, data) => write('info', msg, data),
  warn: (msg, data) => write('warn', msg, data),
  error: (msg, data) => write('error', msg, data),
};
