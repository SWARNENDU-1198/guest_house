import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { setGlobalOptions } from 'firebase-functions/v2';
import { defineSecret } from 'firebase-functions/params';
import { app } from './src/app.js';
import { processQueue } from './src/jobs/processQueue.js';

setGlobalOptions({ region: 'asia-south1', maxInstances: 10 });

// Secrets come from Secret Manager in production and from functions/.secret.local
// in the emulator. They are exposed to the code as process.env values.
const SECRETS = [defineSecret('SERVER_SECRET')];

export const api = onRequest({ secrets: SECRETS, cors: false }, app);

const job = (schedule, fn) => onSchedule({ schedule, timeZone: 'Asia/Kolkata', secrets: SECRETS }, async () => {
  await fn();
});

export const processQueueJob = job('every 1 minutes', processQueue);
