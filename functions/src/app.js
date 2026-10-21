import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config, VERSION } from './config.js';
import { authenticate, requireProfile } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { router as meRouter } from './routes/me.js';
import { router as usersRouter } from './routes/users.js';
import { router as frontdeskRouter } from './routes/frontdesk.js';

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

  // 4. auth for everything below
  v1.use(authenticate);
  v1.use(meRouter); // /auth/bootstrap handles users without a profile itself
  v1.use(requireProfile);
  // 5. routes
  v1.use(usersRouter);
  v1.use(frontdeskRouter);

  // Cloud Functions strips the function name ("/api"), hosting rewrites do not.
  app.use(['/api/v1', '/v1'], v1);
  app.use(notFoundHandler);
  // 6. central error handler
  app.use(errorHandler);
  return app;
}

export const app = createApp();
