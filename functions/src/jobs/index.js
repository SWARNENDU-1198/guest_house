import { expireHolds } from './expireHolds.js';
import { processQueue } from './processQueue.js';
import { sendReminders } from './sendReminders.js';
import { reconcilePayments } from './reconcilePayments.js';

export const JOBS = {
  expireHolds: async () => {
    const r = await expireHolds();
    return { checked: r.checked, expired: r.expired, offers: r.offers.length };
  },
  processQueue: () => processQueue(),
  sendReminders: () => sendReminders(),
  reconcilePayments: () => reconcilePayments(),
};
