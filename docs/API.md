# Guest House API — frontend contract (v1.1)

Base URL
- Functions emulator: `http://127.0.0.1:5001/demo-guesthouse/asia-south1/api/v1`
- Deployed function: `https://asia-south1-<project>.cloudfunctions.net/api/v1`
- Plain Node host (`npm start`): `http://<host>:8080/api/v1`

## The five rules

1. JSON in, JSON out. Dates of stay `YYYY-MM-DD` (IST). Timestamps ISO strings. Money is **integer paise**.
2. Every request except `GET /health`, `POST /webhooks/razorpay` and `POST /internal/jobs/:name` sends
   `Authorization: Bearer <Firebase ID token>`.
3. Roles: `guest`, `official`, `frontdesk`, `accounts`, `admin` (custom claims `role`, `categoryId`, `suspended`).
   A role/category/suspension change **revokes** the user's tokens: the next call returns `401 TOKEN_REVOKED`,
   and the frontend must sign the user in again (a plain `getIdToken(true)` refresh is refused after revocation).
4. Errors are always `{ "error": { "code", "message", "details" } }`.
5. Every state change is transactional and audited.

Unknown body fields and unknown query parameters are rejected with `400 VALIDATION` (`details.issues[]`).

**Sign-in policy (v1.1)** — see [`AUTH.md`](AUTH.md) for the full frontend flow. Every route except
`/health`, `/auth/status`, `/auth/bootstrap`, `/auth/email-otp/*` and `GET /me` needs a **verified email**,
a **verified Indian mobile** (`+91`, from Firebase SMS OTP) and, in production, a session that was opened with an
**SMS OTP**. Cancellations, refunds, Aadhaar verification and user/role changes also need a recent **email OTP**
(step-up, valid 10 minutes).

**Display formats**: the API keeps machine formats (ISO timestamps, `YYYY-MM-DD`, paise). PDFs, emails and CSVs use
Indian formats: `₹1,23,456.78`, `DD/MM/YYYY`, times in IST, amount in words. Document numbers follow the Indian
financial year: `INV/26-27/000001`, `RCPT/26-27/000001`, `SLIP/…`, `CN/…` (file names use `-` instead of `/`).

### Error codes

| HTTP | code | when |
|---|---|---|
| 400 | `VALIDATION` | bad body/query/params, malformed JSON, forged webhook |
| 401 | `UNAUTHENTICATED` | missing / invalid / expired token |
| 401 | `TOKEN_REVOKED` | role or status changed — sign in again |
| 403 | `NOT_BOOTSTRAPPED` | signed in but `POST /auth/bootstrap` not called yet |
| 403 | `FORBIDDEN` | wrong role |
| 403 | `SUSPENDED` | account suspended |
| 403 | `UNVERIFIED` | Aadhaar not verified (booking, queue) |
| 403 | `EMAIL_NOT_VERIFIED` | verify the email first (`POST /auth/email-otp/send { purpose: "verify_email" }`) |
| 403 | `PHONE_NOT_VERIFIED` | no verified `+91` mobile on the Firebase account — link one with the SMS OTP |
| 403 | `LOGIN_OTP_REQUIRED` | session was not opened with an SMS OTP — sign in again with the phone step |
| 403 | `STEP_UP_REQUIRED` | sensitive action: send + verify an email OTP with `purpose: "step_up"`, then retry |
| 422 | `OTP_INVALID` | wrong code (`details.attemptsLeft`) |
| 422 | `OTP_EXPIRED` | code expired or already used — request a new one |
| 429 | `OTP_LOCKED` | 5 wrong attempts — request a new code |
| 429 | `OTP_COOLDOWN` | resend too soon (`details.retryAfterSeconds`; 60 s, max 5 per hour) |
| 502 | `PROVIDER_ERROR` | email / Aadhaar provider failed — retry later |
| 503 | `NOT_CONFIGURED` | Aadhaar OTP provider not enabled on this server (use the QR) |
| 404 | `NOT_FOUND` | missing, or not yours (no existence leaks) |
| 409 | `ROOM_TAKEN` | night already held/booked; `details.canQueue: true`, `details.dates` |
| 409 | `ALREADY_QUEUED` | overlapping active queue entry |
| 409 | `AADHAAR_IN_USE` | that Aadhaar is linked to another account |
| 409 | `INVALID_STATE` | e.g. cancelling a checked-in booking, deciding a request twice |
| 422 | `LIMIT_EXCEEDED` | maxNights, maxAdvanceDays, past date, maxActiveBookings |
| 422 | `OVERDUE_INVOICE` | user has an overdue invoice (`details.invoiceId`) |
| 422 | `HOLD_EXPIRED` | paying for an expired hold |
| 422 | `OFFER_EXPIRED` | accepting a lapsed queue offer |
| 422 | `INVALID_QR` | not a valid / signed Aadhaar secure QR (`details.reason`: `NOT_NUMERIC`, `BAD_SIGNATURE`, `NAME_MISMATCH`, `NO_CERT`, …) |
| 422/400 | `PAYMENT_FAILED` | bad checkout signature (400), payment not captured, gateway refund failure |
| 422 | `IN_USE` | room type change on a room with booked nights |
| 429 | `RATE_LIMITED` | 5/min Aadhaar verify, 6/min email OTP, 10/min booking create, 30/min everything else (per user) |
| 500 | `INTERNAL` | bug — logged server side |

### Conventions
- **Idempotency**: `POST /bookings`, `/bookings/by-type`, `/admin/bookings`, `/payments/order`, `/payments/cash`,
  `/payments/:id/refund` accept `Idempotency-Key` (8–128 chars `[A-Za-z0-9_.:-]`). A repeat returns the first response
  with header `Idempotent-Replayed: true`; a repeat while the first is still running gets `409`.
- **Pagination**: `?limit=20&cursor=<lastDocId>` → `{ items, nextCursor }`.
- **Server time only**: order (`seq`, `requestedAt`) comes from counters and server timestamps.

## What the frontend reads directly from Firestore (read-only)

- `roomNights` where `date` in the visible range → live availability board (`state`: held / booked / occupied / blocked).
- `queue/{id}` → an offer arriving (`state: 'offered'`, `offer.expiresAt`).
- `bookings/{id}` → hold → confirmed after payment.
- Catalogue (`buildings`, `roomTypes`, `rooms`, `categories`, `rates`, `settings/global`).
Any client write is rejected by `firestore.rules`.

## Endpoints

Role legend: **any** = any bootstrapped, non-suspended user.

### v0.1 Foundation
| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/health` | public | `{ ok, version }` |
| POST | `/auth/bootstrap` | signed-in | body `{ name?, phone? }`; creates `users/{uid}` as guest, sets claims; idempotent. The phone comes from the verified Firebase token (`phone` in the body is only used when phone verification is off). Then call `getIdToken(true)`. |
| GET | `/me` | any | `{ profile, verification }`; syncs the profile phone from the token |
| POST | `/admin/users/:uid/role` | admin · step-up | `{ role, reason? }`; revokes tokens; audited |

### v0.2 Users, Aadhaar, officials
| Method | Path | Role | Notes |
|---|---|---|---|
| PATCH | `/me` | any | `{ name? }` (`phone` is rejected while phone verification is on: change it by verifying a new number with the SMS OTP) |
| POST | `/me/aadhaar/verify-qr` | any · step-up | `{ qrData: "<raw scanned decimal string>", consent: true }` → `{ verified, last4, signatureVerified }` |
| POST | `/me/official-request` | guest | `{ department, designation, officialEmail, idProofNote? }` |
| GET | `/admin/official-requests?status=pending` | admin | paginated |
| POST | `/admin/official-requests/:id/decide` | admin | `{ approve, reason? }` (reason required to reject); approve → role official + category official |
| POST | `/frontdesk/walk-in` | frontdesk | `{ name, phone, email, qrData, consent: true }` → verified guest account. `phone`: 10-digit Indian mobile (`98765 43210`, `+91…`, `0…` accepted, stored as `+919876543210`) |
| GET | `/admin/users?role&status&categoryId&officialStatus&q` | admin | `q` = exact email or name prefix |
| PATCH | `/admin/users/:uid` | admin · step-up | `{ categoryId?, status?: active|suspended, reason }` |

### v1.1 Sign-in verification, email OTP, Aadhaar OTP
| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/auth/status` | signed-in | `{ verification: { email, emailVerified, phone, phoneVerified, loginOtp, pending: ['email'|'phone'|'loginOtp'], policy }, bootstrapped }` — works before bootstrap |
| POST | `/auth/email-otp/send` | signed-in | `{ purpose: "verify_email" | "step_up" }` → `{ expiresInSeconds: 600, resendAfterSeconds: 60 }`; 6-digit code by email |
| POST | `/auth/email-otp/verify` | signed-in | `{ purpose, code }` → `{ verified, stepUpUntil, refreshToken }`. After `verify_email`, call `getIdToken(true)` so the token carries `email_verified: true` |
| POST | `/me/aadhaar/otp/send` | any · step-up | `{ aadhaarNumber: "1234 5678 9012", consent: true }` → `{ sessionId, last4, expiresInSeconds }`; UIDAI sends the OTP to the Aadhaar-linked mobile. The number is checked (Verhoeff) and never stored. `503 NOT_CONFIGURED` when no provider is set up |
| POST | `/me/aadhaar/otp/verify` | any | `{ sessionId, otp }` → `{ verified: true, last4, method: "otp" }`; name must match the profile; 3 attempts per session |
| GET/PATCH | `/settings` | read any · write admin | v1.1 adds `organisation: { name, address, phone, email, gstin, sac }` (printed on receipts, invoices, emails; `gstin` validated; CGST/SGST shown when GSTIN and tax are set) |

### v0.3 Catalogue
| Method | Path | Role | Notes |
|---|---|---|---|
| GET/POST | `/buildings` | read any · write admin | `{ name, address }` |
| PATCH | `/buildings/:id` | admin | edit, `active: false` |
| GET/POST | `/room-types` | read any · write admin | `{ id?, name, capacity, amenities[] }` |
| PATCH | `/room-types/:id` | admin | |
| GET/POST | `/rooms?buildingId&roomTypeId&status` | read any · write admin | `{ id?, number, buildingId, roomTypeId, floor }` |
| GET | `/rooms/:id` | any | |
| PATCH | `/rooms/:id` | admin | `{ number?, floor?, roomTypeId?, status?: available|cleaning, active? }` |
| POST | `/rooms/:id/block` | admin | `{ from, to, reason }` — `to` exclusive, like checkOut |
| DELETE | `/rooms/:id/block/:blockId` | admin | freed nights go to the queue first |
| GET/POST | `/categories` | read any · write admin | `{ id?, name, isFree, maxNights, maxAdvanceDays, payLaterAllowed }` |
| PATCH | `/categories/:id` | admin | |
| GET | `/rates` | any | grid; free categories show 0 |
| PUT | `/rates/:categoryId/:roomTypeId` | admin | `{ amountPaise }`, writes history |
| GET | `/rates/:categoryId/:roomTypeId/history` | accounts, admin | |
| GET | `/rates/quote?roomTypeId&checkIn&checkOut` | any | price for the caller's category |
| GET/PATCH | `/settings` | read any · write admin | holdMinutes, offerMinutes, reminderAfterDays, reminderEveryDays, reminderUnit, maxReminders, maxActiveBookings, officialsQueuePriority, taxPercent, refundPolicy[] |

`?includeInactive=true` (admin) shows deactivated catalogue items.

### v0.4 Availability and booking
| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/availability?checkIn&checkOut&roomTypeId&buildingId` | any | `{ rooms[], byType[{ freeCount, perNightPaise, totalPaise }] }` |
| GET | `/availability/board?from&to&roomTypeId&buildingId` | any | room × date grid (max 62 days) |
| POST | `/bookings` | verified | `{ roomId, checkIn, checkOut, payLater? }` → `held` (paid), `confirmed` (free / pay-later) |
| POST | `/bookings/by-type` | verified | `{ roomTypeId, checkIn, checkOut, buildingId?, payLater? }` |
| GET | `/bookings/me` | any | newest check-in first |
| GET | `/bookings/:id` | owner, staff | |
| POST | `/bookings/:id/cancel` | owner, frontdesk, admin · step-up | `{ reason }` → `{ refundDuePaise, refundPercent, offeredToQueue }`; emails the guest |
| POST | `/admin/bookings` | admin, frontdesk | `{ userId, roomId? / roomTypeId?, checkIn, checkOut, payLater?, overrides: { limits?, advance?, overdue?, verification? (admin only) }, reason }` |
| PATCH | `/admin/bookings/:id` | admin | `{ roomId?, checkIn?, checkOut?, reason }` → `{ balanceDuePaise }` |

Booking states: `held → confirmed → checked_in → checked_out`, exits `expired`, `cancelled`, `no_show`.
Each booking has a human code `BK-000123` (front desk lookup).

### v0.5 Queue
| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/queue` | verified | `{ roomTypeId, checkIn, checkOut }` → `{ entry: { seq, position, state } }` |
| GET | `/queue/me` | any | live positions and offers (`?all=true` for history) |
| POST | `/queue/:id/accept` | owner | free → booking confirmed; paid → `{ booking, payNow: true }` |
| POST | `/queue/:id/decline` | owner | next in line gets it |
| DELETE | `/queue/:id` | owner | leave (declines an open offer) |
| GET | `/admin/queue?roomTypeId` | frontdesk, admin | ordered |
| POST | `/admin/queue/:id/move` | admin | `{ newPosition, reason }` |

### v0.6 Payments and receipts
| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/payments/order` | owner | `{ bookingId }` or `{ invoiceId }` → `{ paymentId, orderId, amount, currency, keyId }` → open Razorpay Checkout |
| POST | `/payments/verify` | owner | Checkout handler fields `{ razorpay_order_id, razorpay_payment_id, razorpay_signature }` → `{ status, booking, receipt }` |
| POST | `/webhooks/razorpay` | Razorpay (signed) | configure in the Razorpay dashboard: events payment.captured, payment.failed, order.paid, refund.processed |
| POST | `/payments/cash` | frontdesk, accounts | `{ bookingId | invoiceId, amountPaise, note? }` |
| POST | `/payments/:id/refund` | accounts, admin · step-up | `{ amountPaise, reason }` → credit note (emailed to the guest as PDF) |
| GET | `/payments?status&from&to` | accounts, admin | |
| GET | `/payments/me` | any | |
| GET | `/receipts/me` | any | |
| GET | `/receipts/:id` | owner, staff | frozen snapshot |
| GET | `/receipts/:id/pdf` | owner, staff | `application/pdf` |

Numbers: receipts `RCPT-YYYY-NNNNNN`, free-stay slips `SLIP-…`, credit notes `CN-…`, invoices `INV-…` (each gap-free).

### v0.7 Invoices
| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/invoices/me?status` | any | with `balancePaise` |
| GET | `/invoices/:id` | owner, staff | + `reminders[]` |
| GET | `/invoices/:id/pdf` | owner, staff | |
| POST | `/frontdesk/bookings/:id/charges` | frontdesk | `{ lines: [{ label, amountPaise }] }` creates or extends the charges invoice |
| GET | `/admin/invoices?status` | accounts, admin | with `ageDays` |
| POST | `/admin/invoices/:id/remind` | accounts, admin | send now |
| POST | `/admin/invoices/:id/void` | admin | `{ reason }` |
| POST | `/admin/users/:uid/override-overdue` | admin | `{ reason, allow? }` |

### v0.8 Front desk, dashboards, reports
| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/frontdesk/today` | frontdesk | arrivals, departures, in-house, rooms needing cleaning, room status counts |
| GET | `/frontdesk/lookup?code=BK-000123` | frontdesk | code or booking id |
| POST | `/frontdesk/bookings/:id/check-in` | frontdesk | |
| POST | `/frontdesk/bookings/:id/check-out` | frontdesk | `{ lines? }` → `{ invoiceId, offeredToQueue }` |
| POST | `/frontdesk/bookings/:id/no-show` | frontdesk | `{ reason? }` after the check-in day |
| POST | `/frontdesk/rooms/:id/ready` | frontdesk | cleaning → available |
| GET | `/dashboard/me` | any | |
| GET | `/dashboard/frontdesk` | frontdesk | |
| GET | `/dashboard/accounts` | accounts | |
| GET | `/dashboard/admin` | admin | |
| GET | `/reports/collections?from&to&groupBy=day|category` | accounts, admin | |
| GET | `/reports/occupancy?from&to` | admin | |
| GET | `/reports/payments.csv?from&to` | accounts, admin | Excel-ready CSV |

### v0.9 Audit and jobs
| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/admin/audit?actorUid&entity&entityId&action&from&to` | admin (accounts: payment only) | paginated |
| GET | `/admin/audit/:entity/:entityId` | admin | oldest first |
| GET | `/admin/audit.csv?from&to` | admin | |
| POST | `/admin/jobs/:name/run` | admin | `processQueue`, `expireHolds`, `sendReminders`, `reconcilePayments` (demo) |
| POST | `/internal/jobs/:name` | `X-Cron-Secret` | for a free Node host + external cron |

## Payment flow (frontend)
1. `POST /payments/order { bookingId }` → `{ orderId, amount, keyId }`.
2. Open Razorpay Checkout with `key: keyId, order_id: orderId, amount`.
3. In the handler, `POST /payments/verify` with the three `razorpay_*` fields.
4. Show the receipt (`receipt.id` → `/receipts/:id/pdf`). If the browser closes, the webhook (or the reconciliation job) still confirms;
   the frontend sees it via `onSnapshot(bookings/{id})`.
