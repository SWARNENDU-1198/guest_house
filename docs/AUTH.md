# Sign-in, OTPs and Aadhaar — frontend flow (v1.1)

Everyone who uses the app (guests, front desk, accounts, admins) goes through the same checks. The backend
enforces them on every request; the Firestore rules enforce the first two for direct reads.

| Check | How it is proven | Enforced by | Error when missing |
|---|---|---|---|
| Verified email | 6-digit **email OTP** (`/auth/email-otp/*`) or Firebase's email link | API + Firestore rules | `403 EMAIL_NOT_VERIFIED` |
| Verified Indian mobile | **SMS OTP** through Firebase Phone Auth (`+91…` on the Firebase account) | API + Firestore rules | `403 PHONE_NOT_VERIFIED` |
| This session opened with an SMS OTP | Phone sign-in, or email + password with SMS as second factor | API (production) | `403 LOGIN_OTP_REQUIRED` |
| Recent email OTP for sensitive actions | `purpose: "step_up"`, valid 10 min | API | `403 STEP_UP_REQUIRED` |
| Aadhaar verified (to book) | Aadhaar **secure QR** or **Aadhaar OTP** | API | `403 UNVERIFIED` |

Server switches (all default **on**): `AUTH_REQUIRE_EMAIL_VERIFIED`, `AUTH_REQUIRE_PHONE`,
`AUTH_REQUIRE_LOGIN_OTP` (off by default on the emulator), `AUTH_REQUIRE_STEP_UP`. `GET /auth/status` tells the
frontend what is still pending, so build the UI from `verification.pending` rather than hard-coding the order.

The SMS itself is sent and checked by **Firebase**; the backend only trusts what is in the verified ID token
(`phone_number`, `firebase.sign_in_provider`, `firebase.sign_in_second_factor`). No OTP code ever reaches the API
except the email OTP, which the API issues itself.

## 1. Registration (first time)

```js
import { getAuth, createUserWithEmailAndPassword, updateProfile, RecaptchaVerifier, linkWithPhoneNumber } from 'firebase/auth';
const auth = getAuth();
const call = async (method, path, body) => {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await auth.currentUser.getIdToken()}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  return r.json();
};
const api = (path, body) => call(body ? 'POST' : 'GET', path, body);

// a) account
const { user } = await createUserWithEmailAndPassword(auth, email, password);
await updateProfile(user, { displayName: fullNameAsOnAadhaar });

// b) email OTP (sent by the backend from the college Gmail account)
await api('/auth/email-otp/send', { purpose: 'verify_email' });
await api('/auth/email-otp/verify', { purpose: 'verify_email', code: typedCode });
await user.getIdToken(true);                     // token now has email_verified: true

// c) mobile: SMS OTP by Firebase, linked to the same account
const verifier = new RecaptchaVerifier(auth, 'recaptcha-container', { size: 'invisible' });
const confirmation = await linkWithPhoneNumber(user, `+91${tenDigits}`, verifier);
await confirmation.confirm(typedSmsCode);
await user.getIdToken(true);                     // token now has phone_number: +91…

// d) profile
await api('/auth/bootstrap', { name: fullNameAsOnAadhaar });
await user.getIdToken(true);                     // token now has role / categoryId claims
```

Use the **name exactly as printed on the Aadhaar**: Aadhaar verification compares it (case, spacing and initials
are tolerated).

## 2. Every login: SMS OTP

Pick one style for the app; the backend accepts both.

**A. Mobile number + SMS OTP (simplest, recommended)**

```js
import { signInWithPhoneNumber } from 'firebase/auth';
const confirmation = await signInWithPhoneNumber(auth, `+91${tenDigits}`, verifier);
await confirmation.confirm(typedSmsCode);       // token: sign_in_provider = 'phone'
```

**B. Email + password, then SMS as a second factor** (needs *Identity Platform* + SMS MFA enabled, see
[SETUP-FIREBASE.md](SETUP-FIREBASE.md)). Enrol once after registration with `multiFactor(user).enroll(...)`; at
sign-in catch `auth/multi-factor-auth-required`, use `getMultiFactorResolver` → `PhoneAuthProvider.verifyPhoneNumber`
→ `resolver.resolveSignIn(...)`. The token then has `sign_in_second_factor = 'phone'`.

A password-only session gets `403 LOGIN_OTP_REQUIRED` on every route in production.

## 3. Sensitive actions: email OTP step-up

Cancel booking, Aadhaar verification (QR and OTP), refunds, user status/category and role changes:

```js
let r = await call('POST', `/bookings/${id}/cancel`, { reason });
if (r.error?.code === 'STEP_UP_REQUIRED') {
  await api('/auth/email-otp/send', { purpose: 'step_up' });
  await api('/auth/email-otp/verify', { purpose: 'step_up', code: typedCode });  // valid 10 minutes
  r = await call('POST', `/bookings/${id}/cancel`, { reason });
}
```

OTP rules: 6 digits, valid 10 minutes, single use, 5 wrong tries then `OTP_LOCKED`, resend after 60 s
(`OTP_COOLDOWN`, `details.retryAfterSeconds`), at most 5 per hour. Only an HMAC of the code is stored.

## 4. Aadhaar verification (needed before booking)

**QR (free, works offline):** scan the secure QR on the Aadhaar card / e-Aadhaar PDF / mAadhaar app with any
QR scanner library and send the raw decimal string:

```js
await api('/me/aadhaar/verify-qr', { qrData: scannedDigits, consent: true });
```

**OTP (via the licensed provider, if the college has enabled it):**

```js
const { sessionId } = await api('/me/aadhaar/otp/send', { aadhaarNumber: '1234 5678 9012', consent: true });
// UIDAI sends an OTP to the mobile linked with the Aadhaar (may differ from the login mobile)
await api('/me/aadhaar/otp/verify', { sessionId, otp: typedAadhaarOtp });
```

`503 NOT_CONFIGURED` means the OTP route is not enabled on this server; show the QR option only. Show a consent
line before either: *"I consent to verify my Aadhaar for guest-house registration. Only the last 4 digits, my
name and year of birth are stored."*

Stored: last 4 digits, name, birth year, method, time of consent. Never stored: the Aadhaar number, QR payload,
photo, address.

## 5. Emails the guest receives

All in Indian format (₹, DD/MM/YYYY, IST), from `MAIL_FROM`:

| When | Attachment |
|---|---|
| Email OTP | — |
| Booking held (pay before …) | — |
| Booking confirmed — paid | payment receipt PDF |
| Booking confirmed — pay later (faculty/staff) | invoice PDF |
| Booking confirmed — free (officials) | confirmation slip PDF |
| Payment against an invoice | receipt PDF |
| Booking cancelled (refund amount if any) | — |
| Refund processed | credit note PDF |
| Invoice reminders (day 3, 6, 9) | invoice PDF |
| Queue offer / queue position changed | — |

The same PDFs download from `GET /receipts/:id/pdf` and `GET /invoices/:id/pdf`.

## Emulator notes

- Phone sign-in works on the Auth emulator without real SMS: the code is printed in the emulator log and listed at
  `GET http://127.0.0.1:9099/emulator/v1/projects/demo-guesthouse/verificationCodes`.
- Email OTPs on a `demo-*` project are also stored in clear in `otps/{uid}_{purpose}.emulatorCode` (Emulator UI →
  Firestore) so you can test without a mailbox. This never happens on a real project.
- Demo accounts have mobiles `+91 99999 000 01…07` (admin, frontdesk, accounts, guest, guest2, official, faculty).
