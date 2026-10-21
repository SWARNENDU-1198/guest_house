# Assumptions, defaults and what is mocked

## Open questions from the PRD — defaults used

| Question | Default in v1.0 | Where to change |
|---|---|---|
| Blaze plan? | Built and demoed on the **Local Emulator Suite** (no billing). `npm start` runs the same app on any Node host; jobs via `/internal/jobs/:name` + cron. | — |
| Sign-in method | v1.1: verified email (email OTP) + verified `+91` mobile (Firebase SMS OTP) for everyone; in production every session must be opened with an SMS OTP. Email OTP step-up for sensitive actions. See `AUTH.md`. | `AUTH_REQUIRE_*` env |
| Officials jump the queue? | **No** (`officialsQueuePriority: false`) | `PATCH /settings` |
| Which categories may pay later? | `faculty` and `staff` (`payLaterAllowed: true`); `guest`, `student` pay up front; `official` is free | `PATCH /categories/:id` |
| Refund policy | ≥48 h before check-in (noon IST) 100 %, ≥24 h 50 %, otherwise 0 %. Cancel marks `refundDuePaise`; Accounts executes the refund. | `PATCH /settings { refundPolicy }` |
| GST on receipts? | **No** (`taxPercent: 0`); the receipt shows a tax line when > 0 | `PATCH /settings { taxPercent }` |
| Email sender | JSON transport on the emulator (logged, masked). Production: college Gmail / Workspace account with an app password. | `MAIL_TRANSPORT=gmail`, `MAIL_USER`, `MAIL_FROM`, secret `MAIL_PASS` |
| Display formats | PDFs/emails/CSV: `₹` with Indian grouping, amount in words, `DD/MM/YYYY`, IST; numbers per financial year (`INV/26-27/000001`). API stays ISO/paise. | `lib/format.js` |
| GST | Off unless `settings.organisation.gstin` and `taxPercent` are set; then SAC 996311 and CGST/SGST split (intra-state assumed). | `PATCH /settings` |

## Other decisions

- **Categories seeded**: guest, official, faculty, student, staff (5; the PRD mentions 4 in places).
- **Rate grid** (paise/night, Standard/Deluxe/Suite): guest 2500/4000/7000, faculty 1500/2500/4500, student 800/1200/3000, staff 1200/2000/4000.
- **Max active bookings** per user: 3 (`settings.maxActiveBookings`).
- **Role changes revoke tokens** (PRD rule 3). Because revocation kills the refresh token, the user must sign in again;
  `getIdToken(true)` alone is refused (`401 TOKEN_REVOKED`). Bootstrap does *not* revoke, so a refresh is enough there.
- **Overdue timing**: reminders at day 3, 6, 9; if still unpaid when the 4th would be due (day 12), the invoice becomes overdue.
- **Block ranges** use `to` as exclusive (same as checkOut).
- **Check-in time** for refund calculations: 12:00 IST on the check-in date.
- **Check-in window**: any day from checkIn up to the day before checkOut (late arrivals allowed).
- **No-show** can be marked from the day after checkIn; only tonight-onward nights are released.
- **Queue**: one offer per freed range to the lowest-seq entry that fits all its nights; the minute job also sweeps for missed matches.
  Joining when a matching room is already free gets an immediate offer (still in queue order).
- **Pay-later bookings** are confirmed immediately and an invoice is raised (no hold).
- **Paid after the hold expired**: re-locked if the nights are free, otherwise refunded in full automatically.
- **Extra collection**: `idempotencyKeys` (backend-only) stores Idempotency-Key results. Room blocks live in `rooms/{id}/blocks`.
- **Audit** before/after drop `aadhaar`, `last4`-bearing objects, QR data, signatures, ref hashes, passwords.
- **Rate limits** use the in-memory store, so on Cloud Functions they are per instance (`maxInstances: 10`).

## What is mocked or needs your input

| Item | Status |
|---|---|
| **Razorpay** | No keys were available, so the API runs an **in-process mock gateway** (orders, payments, refunds). Signature checks (checkout and webhook HMAC-SHA256) are real. Set `RAZORPAY_KEY_ID` (.env) + `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` (secrets) to switch to real test mode — no code change. Not yet exercised against Razorpay's servers. |
| **Aadhaar OTP** | UIDAI OTP e-KYC needs a licensed AUA/KUA, so it goes through **Cashfree Secure ID** (`AADHAAR_OTP_PROVIDER=cashfree`). Built against Cashfree's published API (`/verification/offline-aadhaar/otp|verify`, `x-cf-signature`); **not yet run against their sandbox** — do that with sandbox keys first. `mock` provider (OTP 123456) only on the emulator. |
| **UIDAI certificate** | The UIDAI site was unreachable from the build machine, so the real certificate is **not in the repo**. Tests sign QRs in UIDAI's format with a generated test key. Put UIDAI's secure-QR certificate at `functions/config/uidai_cert.pem`. Without it the server **rejects every QR** (fail-closed) unless `AADHAAR_ALLOW_UNSIGNED=true` (demo only). Not yet tried with a real Aadhaar QR — do that with a team member's QR (with consent) before the demo. |
| **Email** | Emulator: JSON transport (not delivered; email OTPs readable at `otps/*.emulatorCode` on `demo-*` projects only). Real delivery needs the Gmail app password (`SETUP-FIREBASE.md` §3). |
| **SMS OTP** | Sent and verified by Firebase Phone Auth (Blaze). Emulator shows codes in its log. Real SMS needs the Blaze project, Phone provider enabled and the India-only SMS region policy. |
| **Deploy** | Not deployed (no Firebase project/Blaze access from here). Steps in README. |
| **Scheduled jobs on the emulator** | The emulator does not fire `onSchedule`. Use `POST /admin/jobs/:name/run` (or call `/internal/jobs/:name` from cron). |
