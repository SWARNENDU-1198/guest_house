# UIDAI certificate

Put UIDAI's Aadhaar Secure QR public certificate here as `uidai_cert.pem`
(download it from UIDAI's "Secure QR code" / offline verification page and, if it
is a `.cer` in DER form, convert it: `openssl x509 -inform der -in uidai.cer -out uidai_cert.pem`).

Or set `UIDAI_CERT_PATH` to its location.

Without the certificate every QR is rejected (`INVALID_QR`, reason `NO_CERT`).
For a local demo only, `AADHAAR_ALLOW_UNSIGNED=true` accepts QRs without checking
the signature and stores `signatureVerified: false`.
