// Money is always integer paise.
export const rupees = (paise) => (paise / 100).toFixed(2);
export const formatINR = (paise) => `Rs. ${Number(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function assertPaise(n) {
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid paise amount: ${n}`);
  return n;
}

export const sumPaise = (items, key = 'amountPaise') => items.reduce((t, i) => t + (i[key] ?? 0), 0);
