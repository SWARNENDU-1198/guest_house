import nodemailer from 'nodemailer';
import { log, maskEmail } from './log.js';

// MAIL_TRANSPORT: 'json' (default; nothing is sent, messages are kept in memory
// and logged with masked addresses), 'smtp' (MAIL_HOST/MAIL_PORT/MAIL_USER/MAIL_PASS),
// or 'gmail' (MAIL_USER + MAIL_PASS app password).
export const outbox = [];
let transporter;

function getTransport() {
  if (transporter) return transporter;
  const mode = process.env.MAIL_TRANSPORT || 'json';
  if (mode === 'gmail') transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS } });
  else if (mode === 'smtp')
    transporter = nodemailer.createTransport({
      host: process.env.MAIL_HOST,
      port: Number(process.env.MAIL_PORT || 587),
      secure: process.env.MAIL_SECURE === 'true',
      auth: process.env.MAIL_USER ? { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS } : undefined,
    });
  else transporter = nodemailer.createTransport({ jsonTransport: true });
  return transporter;
}

export const appUrl = (path = '') => `${process.env.APP_URL || 'http://localhost:5173'}${path}`;

// Never throws: returns { ok, error }.
export async function sendMail({ to, subject, text, tag }) {
  if (!to) return { ok: false, error: 'no recipient' };
  try {
    await getTransport().sendMail({ from: process.env.MAIL_FROM || 'Guest House <no-reply@guesthouse.local>', to, subject, text });
    outbox.push({ to, subject, text, tag, at: new Date() });
    if (outbox.length > 500) outbox.shift();
    log.info('mail.sent', { to: maskEmail(to), subject, tag });
    return { ok: true };
  } catch (e) {
    log.error('mail.failed', { to: maskEmail(to), subject, tag, err: e.message });
    return { ok: false, error: e.message };
  }
}
