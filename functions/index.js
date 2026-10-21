import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { setGlobalOptions } from 'firebase-functions/v2';
import { defineSecret } from 'firebase-functions/params';
import { app } from './src/app.js';
import { processQueue } from './src/jobs/processQueue.js';
import { sendReminders } from './src/jobs/sendReminders.js';
import { reconcilePayments } from './src/jobs/reconcilePayments.js';

setGlobalOptions({ region: 'asia-south1', maxInstances: 10 });

// Secrets come from Secret Manager in production and from functions/.secret.local
// in the emulator. They are exposed to the code as process.env values.
const SECRETS = ['SERVER_SECRET', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'MAIL_PASS', 'CRON_SECRET'].map((s) => defineSecret(s));

export const api = onRequest({ secrets: SECRETS, cors: false }, app);

const job = (schedule, fn) => onSchedule({ schedule, timeZone: 'Asia/Kolkata', secrets: SECRETS }, async () => {
  await fn();
});

export const processQueueJob = job('every 1 minutes', processQueue);
// Hourly in production; set REMINDER_SCHEDULE='every 1 minutes' at deploy time for a live demo.
export const sendRemindersJob = job(process.env.REMINDER_SCHEDULE || 'every 60 minutes', sendReminders);
export const reconcilePaymentsJob = job('every 15 minutes', reconcilePayments);
