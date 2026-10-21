// Indian display formats for PDFs, emails and CSV exports. The API itself keeps
// machine formats (ISO timestamps, YYYY-MM-DD stay dates, integer paise).
const TZ = 'Asia/Kolkata';

const grouped = (paise) => (Number(paise ?? 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// 12345678 paise -> "₹1,23,456.78"
export const inr = (paise) => `₹${grouped(paise)}`;
// Same, for places without the ₹ glyph (email subjects, CSV, SMS)
export const inrText = (paise) => `Rs. ${grouped(paise)}`;

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below100(n) {
  if (n < 20) return ONES[n];
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ''}`;
}

function below1000(n) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', r ? below100(r) : ''].filter(Boolean).join(' ');
}

// Indian numbering: crore, lakh, thousand, hundred.
export function numberToWordsIN(n) {
  n = Math.floor(Number(n));
  if (!n) return 'Zero';
  const parts = [];
  const crore = Math.floor(n / 1e7);
  if (crore) parts.push(`${numberToWordsIN(crore)} Crore`);
  n %= 1e7;
  const lakh = Math.floor(n / 1e5);
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  n %= 1e5;
  const thousand = Math.floor(n / 1000);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  n %= 1000;
  if (n) parts.push(below1000(n));
  return parts.join(' ');
}

// 12345678 paise -> "Rupees One Lakh Twenty-Three Thousand Four Hundred Fifty-Six and Seventy-Eight Paise Only"
export function amountInWords(paise) {
  const p = Math.round(Number(paise ?? 0));
  const rupees = Math.floor(p / 100);
  const rest = p % 100;
  return `Rupees ${numberToWordsIN(rupees)}${rest ? ` and ${below100(rest)} Paise` : ''} Only`;
}

const toDate = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v?.toDate === 'function') return v.toDate(); // Firestore Timestamp
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

// '2026-10-21' (stay date) -> '21/10/2026'
export function dateIN(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// '2026-10-21' -> '21 Oct 2026'
export function dateLongIN(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ''));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
}

const parts = (d) =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );

// Instant -> '21/10/2026, 02:30 PM IST'
export function dateTimeIN(value) {
  const d = toDate(value);
  if (!d) return '';
  const p = parts(d);
  return `${p.day}/${p.month}/${p.year}, ${p.hour}:${p.minute} ${String(p.dayPeriod).toUpperCase()} IST`;
}

// Instant -> '21/10/2026' in IST
export function dateOnlyIN(value) {
  const d = toDate(value);
  if (!d) return '';
  const p = parts(d);
  return `${p.day}/${p.month}/${p.year}`;
}

// '+919876543210' -> '+91 98765 43210'
export function phoneIN(phone) {
  const m = /^\+91(\d{5})(\d{5})$/.exec(String(phone ?? ''));
  return m ? `+91 ${m[1]} ${m[2]}` : (phone ?? '');
}

// Indian financial year of a date, e.g. 21/10/2026 -> '2026-27'
export function financialYearIN(value = new Date()) {
  const d = toDate(value);
  const p = parts(d);
  const y = Number(p.year);
  const start = Number(p.month) >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
