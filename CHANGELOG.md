# Changelog

## v1.1.0 — Verified sign-in, OTPs, real email, Indian formats
**Bug fixes**
- Seed scripts silently did nothing on Windows (`npm run seed`, `npm run seed:demo`): the main-module check compared
  `file://C:\…` with `file:///C:/…`. Now `scripts/isMain.js` (`pathToFileURL`).
- The secrets hygiene test failed on Windows (`URL.pathname` → `C:\C:\…`); now `fileURLToPath`.
- An `Idempotency-Key` whose request died mid-flight stayed `pending` forever (every retry got 409); it is taken
  over after 2 minutes.
- `seed.js` overwrote `settings/global` on every run (a `--prod` re-run reset the admin's settings); it now only
  creates it once. Re-seeding an existing user now also updates email verification and phone.
- Job routes looked up `JOBS[name]` without an own-property check (`constructor`, `toString` resolved).
- Receipts printed raw UTC ISO timestamps; invoice/queue/reminder emails printed `YYYY-MM-DD` and `Rs. 1234.00`.

**Sign-in**
- Every route needs a verified email + verified `+91` mobile (Firebase SMS OTP), and in production a session
  opened with an SMS OTP (phone sign-in or SMS second factor): `EMAIL_NOT_VERIFIED`, `PHONE_NOT_VERIFIED`,
  `LOGIN_OTP_REQUIRED`. Firestore rules require the same for direct reads. `GET /auth/status`.
- Email OTP (`/auth/email-otp/send|verify`): `verify_email` marks the Firebase email verified; `step_up` (10 min)
  is required for cancellations, refunds, Aadhaar verification, user and role changes (`STEP_UP_REQUIRED`).
  HMAC-stored, single-use, 5 attempts, 60 s resend, 5/hour, rate limited.
- Phone comes from the verified token (bootstrap, `GET /me` sync); `PATCH /me` rejects `phone`. Indian mobile
  validation/normalisation (`zPhoneIN`) for walk-ins.
- Switches: `AUTH_REQUIRE_EMAIL_VERIFIED`, `AUTH_REQUIRE_PHONE`, `AUTH_REQUIRE_LOGIN_OTP`, `AUTH_REQUIRE_STEP_UP`.

**Aadhaar**
- Aadhaar OTP through a licensed provider (`AADHAAR_OTP_PROVIDER=cashfree|mock`): `/me/aadhaar/otp/send|verify`,
  Verhoeff check, number never stored, single-use sessions, 3 attempts, same one-Aadhaar-per-account hash as QR.
- UIDAI certificates: every `.cer/.crt/.pem` (DER or PEM) in `functions/config/` is loaded (key rotation).

**Email and documents**
- HTML + text emails for: OTP, booking held, booking confirmed (receipt / invoice / slip PDF attached), payment
  received, cancellation, refund (credit note PDF), invoice reminders (invoice PDF), overdue, queue offer/move.
- New receipt/invoice PDFs: institution header, GSTIN, SAC 996311, CGST/SGST split, `₹` (DejaVu Sans), Indian digit
  grouping, amount in words (lakh/crore), DD/MM/YYYY, IST, masked Aadhaar, +91 phone.
- Document numbers per Indian financial year: `INV/26-27/000001` (≤ 16 chars for GST), `RCPT/…`, `SLIP/…`, `CN/…`.
- `settings.organisation { name, address, phone, email, gstin, sac }`, frozen onto each receipt.
- Payments CSV: `DD/MM/YYYY` and IST date-time columns.

**Ops**: demo/smoke signs in with the real SMS OTP flow on the Auth emulator and completes step-ups;
docs `AUTH.md` (frontend flow) and `SETUP-FIREBASE.md` (Blaze go-live). Tests: 220.

## v0.1.0 — Foundation
- Express API exported as one HTTPS function `api` (region asia-south1), base URL `/api/v1`.
- Middleware order: helmet → CORS (frontend origins only) → JSON (raw body kept) → auth → routes → error handler.
- Auth middleware verifies Firebase ID tokens with revocation check; `requireRole(...)`.
- Roles and category stored as custom claims; role change revokes refresh tokens.
- `writeAudit(tx, actor, {...})` and `nextSeq(tx, name)` helpers.
- `firestore.rules`: no client writes anywhere; reads per data model.
- Seed script: admin account, 5 categories, `settings/global`.
- Endpoints: `GET /health`, `POST /auth/bootstrap`, `GET /me`, `POST /admin/users/:uid/role`.

## v0.2.0 — Users, Aadhaar verification, officials
- `lib/aadhaarQr.js`: decimal → bytes → gunzip → 255-delimited fields; V1 and V2+ layouts;
  RSA-SHA256 signature checked against the UIDAI certificate (`functions/config/uidai_cert.pem`
  or `UIDAI_CERT_PATH`), fail-closed when missing. Name match allows case/space differences and initials.
- One Aadhaar per account via `aadhaarRefs/{HMAC(SERVER_SECRET, last4|name|dob)}`.
- Only `{ last4, verifiedName, birthYear, method, signatureVerified, consentAt, verifiedAt }` stored; audit entries exclude Aadhaar data.
- Endpoints: `PATCH /me`, `POST /me/aadhaar/verify-qr`, `POST /me/official-request`,
  `GET /admin/official-requests`, `POST /admin/official-requests/:id/decide`, `POST /frontdesk/walk-in`,
  `GET /admin/users`, `PATCH /admin/users/:uid`.

## v0.3.0 — Rooms, categories, rates, settings
- Buildings, room types, categories: list (any) / create / edit (admin). No delete endpoints; `active: false` deactivates.
- Rooms with `?buildingId&roomTypeId&status` filters; unique number per building; block/unblock (`to` is exclusive, like checkOut) creates/deletes `roomNights` with state `blocked`.
- Rates grid, `PUT /rates/:categoryId/:roomTypeId` with `rates/{id}/history`, `GET /rates/quote` for the caller's category.
- Free categories always price at 0. `settings/global` read (any) / patch (admin), strict schema.
- All writes audited with before/after.

## v0.4.0 — Availability and booking
- Booking transaction: reads (user, overdue invoices, active bookings, category, room, nights, settings, rate, counter) then writes
  (booking + one `roomNights/{roomId}_{date}` per night via `tx.create` + audit). A lost race becomes `409 ROOM_TAKEN` (`details.canQueue`).
- Rules: Aadhaar verified, not suspended, no overdue invoice, maxNights, maxAdvanceDays, no past dates, `settings.maxActiveBookings`.
- Free categories → `confirmed`, ₹0. Pay-later categories (`payLater: true`) → `confirmed` + invoice. Others → `held` for `holdMinutes`.
- `GET /availability`, `GET /availability/board`, `POST /bookings`, `POST /bookings/by-type`, `GET /bookings/me`, `GET /bookings/:id`,
  `POST /bookings/:id/cancel` (refund due per policy), `POST /admin/bookings` (override flags + reason), `PATCH /admin/bookings/:id`.
- `Idempotency-Key` header on booking creation. Scheduled `expireHoldsJob` (every minute).
- Race test: 50 parallel requests → exactly 1 booking.

## v0.5.0 — First-come queue and offers
- `POST /queue` (seq from `counters/queue`, server `requestedAt`, one active entry per user per overlapping range),
  `GET /queue/me` (computed position + offer), `POST /queue/:id/accept|decline`, `DELETE /queue/:id`,
  `GET /admin/queue`, `POST /admin/queue/:id/move` (reason mandatory, audited, user emailed).
- `lib/release.js`: every path that frees nights (cancel, hold/offer expiry, unblock, admin move, decline) offers them to the
  lowest-seq fitting entry in the same transaction; nights are converted to `held` for that user, never shown free.
- Offers: held booking for `offerMinutes` (30), entry `offered`, email + in-app (listen to `queue/{id}`).
- `processQueueJob` (every minute): expire holds/offers → next in line, expire stale entries, safety sweep.
- Officials priority (`settings.officialsQueuePriority`) orders by [isOfficial desc, seq asc].
- `POST /admin/jobs/:name/run` (admin) and `POST /internal/jobs/:name` (`X-Cron-Secret`, for a free Node host + cron).
- Mailer (`lib/mailer.js`): JSON transport by default; SMTP or Gmail app password via env.

## v0.6.0 — Payments and automatic receipts
- `lib/razorpay.js`: Razorpay SDK when `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` are set, otherwise an in-process mock gateway.
  Checkout signature `HMAC(key_secret, order_id|payment_id)` and webhook signature `HMAC(webhook_secret, raw body)` are always real, timing-safe.
- `POST /payments/order` recomputes the amount from the booking's rate snapshot / invoice balance (client amounts rejected).
- One idempotent confirmation path (`lib/payments.js`) for verify, webhook, reconciliation and cash: payment captured, booking confirmed,
  nights booked, receipt `RCPT-YYYY-NNNNNN` (gap-free counter in the same transaction), audit — exactly once.
- Paid after hold expiry: re-lock if the nights are still free, otherwise automatic full refund + email.
- `POST /webhooks/razorpay` (payment.captured, order.paid, payment.failed, refund.processed), idempotent via `webhookEvents/{eventId}`.
- `POST /payments/cash`, `POST /payments/:id/refund` (+ credit note `CN-…`), `GET /payments`, `GET /payments/me`,
  `GET /receipts/me`, `GET /receipts/:id`, `GET /receipts/:id/pdf` (pdfkit, rendered from the frozen snapshot).
- Free bookings get a ₹0 confirmation slip (`SLIP-…`).

## v0.7.0 — Invoices and 3-day reminders
- Invoices `INV-YYYY-NNNNNN` for pay-later stays (`kind: stay`) and front-desk extra charges (`kind: charges`, extended while unpaid).
- `sendRemindersJob` (hourly; `REMINDER_SCHEDULE` to change): unpaid invoices with `nextReminderAt <= now` get an email with a pay link,
  a `reminders` doc, `remindersSent++` and `nextReminderAt += reminderEveryDays` in one transaction (never double-sends).
  When `remindersSent` reaches `maxReminders` (3), the next due run marks the invoice `overdue`, emails Accounts, and the user is blocked
  (`OVERDUE_INVOICE`) from booking and queueing until paid or an admin overrides.
- `reminderUnit: 'minutes'` setting for live demos.
- `GET /invoices/me`, `GET /invoices/:id` (+ reminder history), `GET /invoices/:id/pdf`, `POST /frontdesk/bookings/:id/charges`,
  `GET /admin/invoices` (with `ageDays`), `POST /admin/invoices/:id/remind`, `POST /admin/invoices/:id/void`,
  `POST /admin/users/:uid/override-overdue`. Partial payments leave a balance; overpaying is refused.

## v0.8.0 — Front desk, dashboards, reports
- `GET /frontdesk/today`, `GET /frontdesk/lookup?code` (booking code `BK-…` or id), `POST /frontdesk/bookings/:id/check-in`
  (confirmed + stay covers today → room occupied, nights occupied), `POST /frontdesk/bookings/:id/check-out` (optional charges → invoice,
  room → cleaning, early check-out releases tonight onward → queue), `POST /frontdesk/bookings/:id/no-show`, `POST /frontdesk/rooms/:id/ready`.
- One-call dashboards: `GET /dashboard/me|frontdesk|accounts|admin`.
- Reports: `GET /reports/collections?groupBy=day|category`, `GET /reports/occupancy`, `GET /reports/payments.csv`
  (UTF-8 BOM, CRLF, quoted, formula-injection safe).

## v0.9.0 — Audit viewer and hardening
- `GET /admin/audit` (filters actorUid/entity/entityId/action/from/to, cursor pagination; Accounts limited to payment entries),
  `GET /admin/audit/:entity/:entityId`, `GET /admin/audit.csv`. No update/delete endpoints exist.
- Rate limits per user: 5/min Aadhaar verify (and walk-in), 10/min booking create, 30/min general; 429 `RATE_LIMITED` with standard headers.
- Validation sweep: every route runs zod; a missing query schema means no query params allowed, a missing body schema means empty body only.
  A test walks the route table to prove it.
- `trust proxy` = 1 hop; body limit 200 kB; CORS allow-list; helmet.
- Secrets via `defineSecret` (SERVER_SECRET, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, MAIL_PASS, CRON_SECRET); `.env.example`, `.secret.local.example`.
- `reconcilePaymentsJob` (every 15 min): asks Razorpay about orders with no verify/webhook; confirms (or auto-refunds), fails, or abandons.
- Extra composite indexes for every query the API runs.
- Tests: rules matrix (all collections × all roles × read/write), 50-way race, queue cancel→offer→expire→next, webhook valid/forged/duplicate,
  reminder exactly-once, rate limits, validation, audit viewer, log redaction, secret scan, reconciliation.

## v1.0.0 — Demo-ready
- `npm run seed:demo`: 2 buildings, 3 room types, 10 rooms, full rate grid, a user for every role, past stays with receipts,
  an overdue invoice, an upcoming stay and a waiting queue entry.
- `npm run demo`: starts the emulators, seeds, and runs `scripts/smoke.js` over real HTTP (book → pay → receipt,
  cancel → queue offer, live reminder, audited rate change, dashboards < 1 s, security spot checks).
- `server.js`: the same app on any Node host, with `/internal/jobs/:name` for an external cron.
- Docs: README (setup, emulator, deploy), `docs/API.md` (frontend contract), `docs/api.http`, `docs/ASSUMPTIONS.md`.
