# UIDAI certificates

Put UIDAI's public certificate(s) for **Secure QR / Paperless Offline e-KYC** in this folder, exactly as
downloaded from UIDAI's developer section ("UIDAI Certificate Details"). `.cer`, `.crt` and `.pem` files in DER
or PEM form are all loaded, and a QR is accepted if it matches any of them, so the old and new keys can sit side
by side when UIDAI rotates them.

Or set `UIDAI_CERT_PATH` to a single file or a folder.

Without a certificate every QR is rejected (`INVALID_QR`, reason `NO_CERT`).
For a local demo only, `AADHAAR_ALLOW_UNSIGNED=true` accepts QRs without checking
the signature and stores `signatureVerified: false`.

Files starting with `test_` are ignored (tests generate their own key).
