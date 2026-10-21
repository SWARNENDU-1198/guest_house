import { db } from '../firebase.js';

export const DEFAULT_SETTINGS = {
  holdMinutes: 10,
  offerMinutes: 30,
  reminderAfterDays: 3,
  reminderEveryDays: 3,
  reminderUnit: 'days', // 'minutes' for live demos
  maxReminders: 3,
  maxActiveBookings: 3,
  officialsQueuePriority: false,
  taxPercent: 0,
  // Printed on receipts, invoices and emails. gstin/sac only show when set.
  organisation: {
    name: 'College Guest House',
    address: '',
    phone: '',
    email: '',
    gstin: '',
    sac: '996311', // SAC for room accommodation services
  },
  // Cancellation refunds: the first rule whose hoursBefore <= hours left before check-in applies.
  refundPolicy: [
    { hoursBefore: 48, percent: 100 },
    { hoursBefore: 24, percent: 50 },
    { hoursBefore: 0, percent: 0 },
  ],
};

export const settingsRef = () => db.collection('settings').doc('global');

export const withDefaults = (data) => ({
  ...DEFAULT_SETTINGS,
  ...(data ?? {}),
  organisation: { ...DEFAULT_SETTINGS.organisation, ...(data?.organisation ?? {}) },
});

export async function getSettings(tx) {
  const snap = tx ? await tx.get(settingsRef()) : await settingsRef().get();
  return withDefaults(snap.exists ? snap.data() : null);
}
