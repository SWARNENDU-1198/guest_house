import { db } from '../firebase.js';

// One document per room per night: the no-double-booking lock.
export const nightRef = (roomId, date) => db.collection('roomNights').doc(`${roomId}_${date}`);
