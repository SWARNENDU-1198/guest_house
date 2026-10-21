// Dates of stay are YYYY-MM-DD strings in IST (UTC+05:30, no DST).
const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const todayIST = (now = Date.now()) => new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10);

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const diffDays = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

// Nights of a stay: [checkIn, checkOut)
export function nightsBetween(checkIn, checkOut) {
  const n = diffDays(checkIn, checkOut);
  return Array.from({ length: Math.max(0, n) }, (_, i) => addDays(checkIn, i));
}

export const overlaps = (aIn, aOut, bIn, bOut) => aIn < bOut && bIn < aOut;

// Midnight IST at the start of a date, as a JS Date (for "hours before check-in").
export const istMidnight = (date) => new Date(Date.parse(`${date}T00:00:00Z`) - IST_OFFSET_MS);

export const yearIST = (now = Date.now()) => todayIST(now).slice(0, 4);
