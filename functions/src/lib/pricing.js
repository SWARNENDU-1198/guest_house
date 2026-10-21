import { db } from '../firebase.js';
import { notFound, unprocessable, CODES } from '../middleware/errors.js';

export const rateRef = (categoryId, roomTypeId) => db.collection('rates').doc(`${categoryId}_${roomTypeId}`);

// Price for a stay. Free categories are always 0, whatever the rate grid says.
export function priceStay({ category, rate, nights, taxPercent = 0 }) {
  if (category.isFree) {
    return { isFree: true, nights, perNightPaise: 0, subtotalPaise: 0, taxPercent: 0, taxPaise: 0, totalPaise: 0 };
  }
  if (!rate) throw unprocessable(CODES.NOT_FOUND, 'No rate is set for this category and room type');
  const perNightPaise = rate.amountPaise;
  const subtotalPaise = perNightPaise * nights;
  const taxPaise = Math.round((subtotalPaise * taxPercent) / 100);
  return { isFree: false, nights, perNightPaise, subtotalPaise, taxPercent, taxPaise, totalPaise: subtotalPaise + taxPaise };
}

// Frozen copy stored on the booking; later rate changes never touch it.
export const rateSnapshot = ({ categoryId, roomTypeId, price }) => ({
  categoryId,
  roomTypeId,
  perNightPaise: price.perNightPaise,
  nights: price.nights,
  subtotalPaise: price.subtotalPaise,
  taxPercent: price.taxPercent,
  taxPaise: price.taxPaise,
  totalPaise: price.totalPaise,
  isFree: price.isFree,
});

export async function loadCategory(tx, categoryId) {
  const ref = db.collection('categories').doc(categoryId || 'guest');
  const snap = tx ? await tx.get(ref) : await ref.get();
  if (!snap.exists) throw notFound('Category');
  return { id: snap.id, ...snap.data() };
}
