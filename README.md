# Guest House Room Booking — Backend

One Express API (`/api/v1`) exported as the HTTPS Cloud Function `api` (asia-south1), on Firebase Auth + Firestore,
with scheduled jobs, Razorpay, PDF receipts/invoices and email reminders. Built in versions v0.1 → v1.0 (see `CHANGELOG.md`, git tags).

- Frontend contract: [`docs/API.md`](docs/API.md) · request examples: [`docs/api.http`](docs/api.http)
- Defaults, decisions, what is mocked: [`docs/ASSUMPTIONS.md`](docs/ASSUMPTIONS.md)

## Requirements
Node 22, Java 21+ (for the emulators), `npm i -g firebase-tools`.

## Run locally (no Firebase project or billing needed)
```bash
cd functions
npm install
cp .secret.local.example .secret.local     # local placeholder secrets (gitignored)
cp .env.example .env                       # optional; defaults work on the emulator

npm test        # starts Auth + Firestore emulators, runs all 202 tests, stops
npm run demo    # starts Functions + Auth + Firestore, seeds demo data, runs the HTTP smoke demo (~2 min)
```

Interactive:
```bash
npm run serve                 # emulators + Emulator UI at http://127.0.0.1:4000
npm run seed:demo             # in a second terminal
npm run smoke -- --fast       # optional scripted walkthrough
```
API base: `http://127.0.0.1:5001/demo-guesthouse/asia-south1/api/v1`.
Scheduled jobs do not fire on the emulator: run them with `POST /admin/jobs/{processQueue|expireHolds|sendReminders|reconcilePayments}/run`.

### Demo accounts (password `demo1234!`)
`admin@`, `frontdesk@`, `accounts@`, `guest@`, `guest2@`, `official@`, `faculty@` and `newbie@` (not Aadhaar-verified) — all `@guesthouse.test`.

## Configuration
| Kind | Name | Notes |
|---|---|---|
| secret | `SERVER_SECRET` | HMAC key for Aadhaar ref hashes (long random) |
| secret | `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | from the Razorpay dashboard |
| secret | `MAIL_PASS` | Gmail app password / SMTP password |
| secret | `CRON_SECRET` | only for the plain Node host |
| env | `RAZORPAY_KEY_ID` | public key id; unset → in-process mock gateway |
| env | `CORS_ORIGINS`, `APP_URL` | frontend origin(s) |
| env | `MAIL_TRANSPORT` (`json`/`gmail`/`smtp`), `MAIL_USER`, `MAIL_FROM` | |
| file | `functions/config/uidai_cert.pem` | UIDAI secure-QR certificate; without it QR checks fail closed |

Never commit `.env` or `.secret.local` (both gitignored); only the public key id reaches the frontend.

## Deploy
**Firebase (Blaze plan, needed for Functions + schedules):**
```bash
firebase use --add <project-id>
firebase functions:secrets:set SERVER_SECRET        # repeat for each secret
firebase deploy --only firestore:rules,firestore:indexes,functions
cd functions && SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='<strong password>' node scripts/seed.js --prod
```
Then add the webhook `https://asia-south1-<project>.cloudfunctions.net/api/v1/webhooks/razorpay` in Razorpay.

**Free Node host (Render, Railway, a VM):** `npm start` runs `server.js` with a service account
(`GOOGLE_APPLICATION_CREDENTIALS`). Call `POST /api/v1/internal/jobs/processQueue` every minute,
`sendReminders` hourly and `reconcilePayments` every 15 min with header `X-Cron-Secret`.

## Layout
```
firestore.rules, firestore.indexes.json, firebase.json
functions/
  index.js            Cloud Functions entry (api + 3 schedules)
  server.js           plain Node entry
  src/app.js          middleware order and router mounting
  src/middleware/     auth, roles, zod validation, rate limits, errors
  src/routes/         one file per area
  src/lib/            booking/queue/payments/invoicing/receipts/aadhaar/audit logic
  src/jobs/           expireHolds, processQueue, sendReminders, reconcilePayments
  scripts/            seed, seedDemo, smoke
  test/               v01…v09, race, rules
```
