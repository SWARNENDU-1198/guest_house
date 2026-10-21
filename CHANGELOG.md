# Changelog

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
