import { expireHolds } from './expireHolds.js';
import { processQueue } from './processQueue.js';

export const JOBS = {
  expireHolds: async () => {
    const r = await expireHolds();
    return { checked: r.checked, expired: r.expired, offers: r.offers.length };
  },
  processQueue: () => processQueue(),
};
