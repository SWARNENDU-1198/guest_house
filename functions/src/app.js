import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config, VERSION } from './config.js';
import { authenticate, requireProfile } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { router as meRouter } from './routes/me.js';
import { router as usersRouter } from './routes/users.js';
import { router as frontdeskRouter } from './routes/frontdesk.js';
import { router as catalogRouter } from './routes/catalog.js';
import { router as roomsRouter } from './routes/rooms.js';
import { router as settingsRouter } from './routes/settings.js';
import { router as availabilityRouter } from './routes/availability.js';
import { router as bookingsRouter } from './routes/bookings.js';
import { router as queueRouter } from './routes/queue.js';
import { adminJobs, cronJobs } from './routes/jobs.js';
import { router as paymentsRouter } from './routes/payments.js';
import { router as webhooksRouter } from './routes/webhooks.js';
import { router as receiptsRouter } from './routes/receipts.js';
import { router as invoicesRouter } from './routes/invoices.js';
import { router as dashboardsRouter } from './routes/dashboards.js';
import { router as reportsRouter } from './routes/reports.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // 1. security headers
  app.use(helmet());
  // 2. CORS: frontend origins only (requests without Origin, e.g. curl/webhooks, pass)
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
      maxAge: 600,
    }),
  );
  // 3. JSON body, keeping the raw bytes for webhook signature checks.
  //    (On Cloud Functions the body is already parsed and req.rawBody is set.)
  app.use(
    express.json({
      limit: '200kb',
      verify: (req, res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  const v1 = express.Router();

  // Public routes
  v1.get('/health', (req, res) => res.json({ ok: true, version: VERSION }));
  v1.use(cronJobs);
  v1.use(webhooksRouter); // signed by Razorpay, no Firebase token

  // 4. auth for everything below
  v1.use(authenticate);
  v1.use(meRouter); // /auth/bootstrap handles users without a profile itself
  v1.use(requireProfile);
  // 5. routes
  v1.use(usersRouter);
  v1.use(frontdeskRouter);
  v1.use(catalogRouter);
  v1.use(roomsRouter);
  v1.use(settingsRouter);
  v1.use(availabilityRouter);
  v1.use(bookingsRouter);
  v1.use(queueRouter);
  v1.use(adminJobs);
  v1.use(paymentsRouter);
  v1.use(receiptsRouter);
  v1.use(invoicesRouter);
  v1.use(dashboardsRouter);
  v1.use(reportsRouter);

  // Cloud Functions strips the function name ("/api"), hosting rewrites do not.
  app.use(['/api/v1', '/v1'], v1);
  app.use(notFoundHandler);
  // 6. central error handler
  app.use(errorHandler);
  return app;
}

export const app = createApp();
