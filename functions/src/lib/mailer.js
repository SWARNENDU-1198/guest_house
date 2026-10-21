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
  if (mode === 'gmail') {
    transporter = nodemailer.createTransport({ service: 'gmail', pool: true, maxConnections: 3, auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS } });
  } else if (mode === 'smtp') {
    transporter = nodemailer.createTransport({
      host: process.env.MAIL_HOST,
      port: Number(process.env.MAIL_PORT || 587),
      secure: process.env.MAIL_SECURE === 'true',
      auth: process.env.MAIL_USER ? { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS } : undefined,
    });
  } else transporter = nodemailer.createTransport({ jsonTransport: true });
  return transporter;
}

// Tests swap the transport; also used after config changes.
export function resetTransport() {
  transporter = undefined;
}

export const mailFrom = () => process.env.MAIL_FROM || (process.env.MAIL_USER ? `Guest House <${process.env.MAIL_USER}>` : 'Guest House <no-reply@guesthouse.local>');

export const appUrl = (path = '') => `${process.env.APP_URL || 'http://localhost:5173'}${path}`;

// Never throws: returns { ok, error }.
// attachments: [{ filename, content: Buffer, contentType }]
export async function sendMail({ to, subject, text, html, attachments, tag }) {
  if (!to) return { ok: false, error: 'no recipient' };
  try {
    await getTransport().sendMail({ from: mailFrom(), to, subject, text, html, attachments });
    outbox.push({ to, subject, text, html, tag, attachments: (attachments ?? []).map((a) => ({ filename: a.filename, size: a.content?.length ?? 0 })), at: new Date() });
    if (outbox.length > 500) outbox.shift();
    log.info('mail.sent', { to: maskEmail(to), subject, tag });
    return { ok: true };
  } catch (e) {
    log.error('mail.failed', { to: maskEmail(to), subject, tag, err: e.message });
    return { ok: false, error: e.message };
  }
}
