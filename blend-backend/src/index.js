// src/index.js
// BLEND platform server entry point.

import 'dotenv/config';
import express       from 'express';
import cors          from 'cors';
import helmet        from 'helmet';
import rateLimit     from 'express-rate-limit';
import router, { stripeWebhookHandler } from './routes/index.js';
import { startWorkers } from './workers/subscriptionWorker.js';

const app  = express();
const PORT = process.env.PORT ?? 3000;

// ─── STRIPE WEBHOOK ───────────────────────────────────────────────────────────
// Must be registered BEFORE express.json() so raw body is preserved.
app.post('/api/v1/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler);

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    // Allow any vercel.app domain, localhost, and the configured FRONTEND_URL
    const allowed = [
      process.env.FRONTEND_URL,
      'http://localhost:5173',
      'http://localhost:3000',
    ].filter(Boolean);
    if (
      allowed.includes(origin) ||
      origin.endsWith('.vercel.app') ||
      origin.includes('localhost')
    ) {
      return callback(null, true);
    }
    return callback(null, true); // Allow all for MVP, tighten later
  },
  credentials: true,
}));
app.use(express.json());
app.use(rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Please slow down.' },
}));

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, service: 'blend-backend', ts: new Date().toISOString() }));

// ─── API ROUTES ───────────────────────────────────────────────────────────────
app.use('/api/v1', router);

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found.' }));

// ─── ERROR HANDLER ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Server]', err);
  res.status(500).json({ ok: false, error: 'Internal server error.' });
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] BLEND backend running on port ${PORT}`);
  if (process.env.NODE_ENV !== 'test') startWorkers();
});
