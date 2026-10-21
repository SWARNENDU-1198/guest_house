# Going live on Firebase (Blaze) — step by step

Everything below is done once by whoever owns the college's Firebase project. Commands run from the repo root
unless they start with `cd functions`.

## 1. Project

1. <https://console.firebase.google.com> → **Add project** (e.g. `college-guesthouse`). Analytics optional.
2. **Upgrade to Blaze** (Usage and billing). Add a **budget alert** (e.g. ₹500/month) in Google Cloud Billing.
   At college scale Functions, Firestore and Gmail cost ≈ ₹0; SMS OTPs are the only real cost (about ₹1–2 each in India).
3. **Firestore** → Create database → **Production mode** → location **asia-south1 (Mumbai)**. The location cannot be changed later.
4. Locally:
   ```bash
   npm i -g firebase-tools && firebase login
   firebase use --add            # pick the project, alias "default"
   ```
   This writes your project id to `.firebaserc` (replace `demo-guesthouse` there).

## 2. Authentication (email + SMS OTP)

Console → **Authentication** → Get started:

1. **Sign-in method** → enable **Email/Password** and **Phone**.
2. **Settings → SMS region policy** → *Allow* only **India (+91)**. This stops SMS-pumping fraud from other countries.
3. **Settings → Authorized domains** → add the frontend's domain (e.g. `guesthouse.college.ac.in`).
4. Optional, if you want email + password with SMS as the second factor (option B in [AUTH.md](AUTH.md)):
   **Settings → Upgrade to Identity Platform** (free up to 50,000 monthly users), then **Multi-factor
   authentication → SMS → Enable**. Option A (mobile + SMS OTP sign-in) does not need this.
5. **Phone numbers for testing** (Sign-in method → Phone): add a few `+91` numbers with fixed codes for
   demos and app reviews. They never send a real SMS.
6. Strongly recommended: **App Check** with reCAPTCHA Enterprise for the web app, then enforce it for
   Authentication. It blocks scripted SMS abuse.

## 3. Email (Gmail / college Google account)

1. Use a dedicated account, e.g. `guesthouse@college.ac.in` (Google Workspace: 2,000 emails/day) or a Gmail
   account (500/day).
2. Turn on **2-Step Verification** for that account → <https://myaccount.google.com/apppasswords> → create an
   app password named "Guest house API". You get 16 characters.
3. Put the address in `functions/.env` (below) and the app password in Secret Manager as `MAIL_PASS`.
4. Workspace admins: make sure *Less secure apps* is not needed. App passwords work with 2-Step Verification on.
   Add SPF/DKIM for the domain so mail does not land in spam (Workspace does this for its own domain).

## 4. Aadhaar

**QR (always on):** download UIDAI's public certificate(s) for *Secure QR / Paperless Offline e-KYC* from
UIDAI's developer section ("UIDAI Certificate Details",
<https://uidai.gov.in/en/916-developer-section/data-and-downloads-section.html>) and put the `.cer` file(s)
as they are into `functions/config/`. DER or PEM both work, and several files can sit side by side so key
rotation needs no code change. Without a certificate every QR is rejected (fail-closed). After deploying,
verify once with a real Aadhaar QR from a team member (with consent).

**OTP (optional, paid):** UIDAI only gives OTP e-KYC to licensed agencies, so this goes through
**Cashfree Secure ID** (about ₹3–10 per verification):

1. Sign up at Cashfree → Secure ID → complete the college's KYC → get **sandbox** Client ID / Secret.
2. Developers → **Two-factor authentication / Public key** → download the public key (`.pem`). Cloud Functions has
   no fixed outgoing IP, so the API signs each call with it instead of IP whitelisting.
3. Sandbox test data: Aadhaar `655675523712`, OTP `111000` (valid) / `000111` (invalid).
4. Set `AADHAAR_OTP_PROVIDER=cashfree`, `CASHFREE_ENV=sandbox`, `CASHFREE_CLIENT_ID` in `.env`; secrets
   `CASHFREE_CLIENT_SECRET` and `CASHFREE_PUBLIC_KEY` (paste the whole PEM). Test, then switch to `production` keys.

Leave `AADHAAR_OTP_PROVIDER` unset to offer only the QR. The OTP route then answers `503 NOT_CONFIGURED`.

## 5. Configuration

`functions/.env` (not secret; never commit it):

```ini
CORS_ORIGINS=https://guesthouse.college.ac.in
APP_URL=https://guesthouse.college.ac.in
MAIL_TRANSPORT=gmail
MAIL_USER=guesthouse@college.ac.in
MAIL_FROM=College Guest House <guesthouse@college.ac.in>
RAZORPAY_KEY_ID=rzp_test_xxxxxxxx          # unset = built-in mock gateway
# Aadhaar OTP (optional)
AADHAAR_OTP_PROVIDER=cashfree
CASHFREE_ENV=sandbox
CASHFREE_CLIENT_ID=CF_xxxxxxxx
# Sign-in policy: all default to true in production. Only relax for testing.
# AUTH_REQUIRE_EMAIL_VERIFIED=true
# AUTH_REQUIRE_PHONE=true
# AUTH_REQUIRE_LOGIN_OTP=true
# AUTH_REQUIRE_STEP_UP=true
```

Secrets (Secret Manager; each command prompts for the value):

```bash
firebase functions:secrets:set SERVER_SECRET            # 48+ random chars: node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"
firebase functions:secrets:set MAIL_PASS                # Gmail app password
firebase functions:secrets:set RAZORPAY_KEY_SECRET
firebase functions:secrets:set RAZORPAY_WEBHOOK_SECRET
firebase functions:secrets:set CRON_SECRET              # any 32+ chars (only used by the plain Node host)
# only with AADHAAR_OTP_PROVIDER=cashfree:
firebase functions:secrets:set CASHFREE_CLIENT_SECRET
firebase functions:secrets:set CASHFREE_PUBLIC_KEY
```

For the **emulator**, put the same names in `functions/.secret.local` (`NAME=value` per line; gitignored).
`SERVER_SECRET` is required there too, since email OTP and Aadhaar hashing use it.

## 6. Deploy and first admin

```bash
cd functions && npm install && npm test && cd ..
firebase deploy --only firestore:rules,firestore:indexes,functions
cd functions
SEED_ADMIN_EMAIL=warden@college.ac.in SEED_ADMIN_PASSWORD='<strong password>' SEED_ADMIN_PHONE=+919876543210 \
  GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json GCLOUD_PROJECT=<project-id> node scripts/seed.js --prod
```

(PowerShell: set each variable with `$env:NAME = 'value'` first.) The admin's phone must be a real `+91` mobile:
it is how they will sign in with the SMS OTP.

Then, signed in as that admin, set the institution details printed on every receipt:

```http
PATCH /api/v1/settings
{ "organisation": { "name": "IIT … Guest House", "address": "…, PIN 721302", "phone": "+91 …", "email": "guesthouse@college.ac.in", "gstin": "" } }
```

Leave `gstin` empty unless the guest house is GST-registered. With a GSTIN and `taxPercent` > 0, receipts become tax
invoices with SAC 996311 and a CGST/SGST split.

Razorpay: add the webhook `https://asia-south1-<project>.cloudfunctions.net/api/v1/webhooks/razorpay`
(events `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`) with the same webhook secret.

## 7. Go-live checklist

- [ ] `GET /api/v1/health` returns `version: 1.1.0`
- [ ] New account: email OTP arrives from the college address (check spam), SMS OTP arrives, `/auth/status` → `pending: []`
- [ ] Password-only session gets `LOGIN_OTP_REQUIRED`
- [ ] Real Aadhaar QR verifies with `signatureVerified: true`
- [ ] Book → pay with Razorpay test card/UPI → confirmation email with receipt PDF (₹, DD/MM/YYYY, IST)
- [ ] Cancel asks for the email code, then sends the cancellation email
- [ ] Budget alert and SMS region policy (India only) are set
- [ ] Privacy notice / consent text shown before Aadhaar (Aadhaar Act s.8, DPDP Act 2023)
