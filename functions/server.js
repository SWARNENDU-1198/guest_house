// Runs the same Express app on any Node host (e.g. Render free tier) instead of
// Cloud Functions. Credentials: GOOGLE_APPLICATION_CREDENTIALS (service account)
// and GCLOUD_PROJECT. Scheduled jobs: have a cron service POST to
// /api/v1/internal/jobs/{processQueue|sendReminders|reconcilePayments}
// with header X-Cron-Secret: $CRON_SECRET.
import { app } from './src/app.js';

const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`Guest house API listening on :${port} (base /api/v1)`));
