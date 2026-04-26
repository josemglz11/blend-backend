// src/routes/index.js
// All API routes. Mount this at /api/v1 in src/index.js.

import { Router }         from 'express';
import { z }              from 'zod';
import Stripe             from 'stripe';
import { PrismaClient }   from '@prisma/client';

import RecommendationEngine from '../services/RecommendationEngine.js';
import BlendSpecService     from '../services/BlendSpecService.js';
import SubscriptionService  from '../services/SubscriptionService.js';
import OrderService         from '../services/OrderService.js';

const router = Router();
const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function ok(res, data, status = 200) {
  return res.status(status).json({ ok: true, data });
}

function err(res, message, status = 400) {
  return res.status(status).json({ ok: false, error: message });
}

function validate(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) throw new Error(result.error.errors.map(e => e.message).join(', '));
  return result.data;
}

// Simple auth middleware. Replace with your preferred auth system.
// In production, use JWTs, Clerk, Auth0, or similar.
async function requireAuth(req, res, next) {
  const customerId = req.headers['x-customer-id'];
  if (!customerId) return err(res, 'Unauthorized.', 401);
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) return err(res, 'Customer not found.', 401);
  req.customer = customer;
  next();
}

// ─── QUIZ ─────────────────────────────────────────────────────────────────────

// POST /api/v1/quiz/recommend
// Takes quiz answers, returns a recommended BlendSpec (not yet persisted).
router.post('/quiz/recommend', async (req, res) => {
  try {
    const schema = z.object({
      answers:       z.record(z.unknown()),
      quizVersion:   z.string().default('1.0.0'),
      ruleSetVersion: z.string().default('1.0.0'),
    });
    const { answers, quizVersion, ruleSetVersion } = validate(schema, req.body);
    const recommendation = RecommendationEngine.recommend(answers, ruleSetVersion);
    const summary        = RecommendationEngine.buildReasonSummary(recommendation);
    ok(res, { recommendation, summary });
  } catch (e) { err(res, e.message); }
});

// ─── BLEND SPECS ──────────────────────────────────────────────────────────────

// POST /api/v1/blend-specs
// Create and persist a BlendSpec. Called when user confirms from configurator.
router.post('/blend-specs', async (req, res) => {
  try {
    const schema = z.object({
      baseSlug:     z.string(),
      flavorSlug:   z.string(),
      proteinGrams: z.number(),
      addInSlugs:   z.array(z.string()).default([]),
      quizAnswers:  z.record(z.unknown()).optional(),
      quizVersion:  z.string().optional(),
    });
    const input  = validate(schema, req.body);
    const spec   = await BlendSpecService.create(input);
    ok(res, spec, 201);
  } catch (e) { err(res, e.message); }
});

// GET /api/v1/blend-specs/:id
router.get('/blend-specs/:id', async (req, res) => {
  try {
    const spec = await BlendSpecService.getById(req.params.id);
    ok(res, spec);
  } catch (e) { err(res, e.message, 404); }
});

// GET /api/v1/pricing?baseSlug=&proteinGrams=&addInSlugs=
// Live pricing without creating a spec. Used by the configurator.
router.get('/pricing', async (req, res) => {
  try {
    const { baseSlug, proteinGrams, addInSlugs } = req.query;
    const { calculatePrice, calculateMacros } = await import('../services/BlendSpecService.js');
    const slugs  = addInSlugs ? addInSlugs.split(',') : [];
    const price  = calculatePrice(baseSlug, parseInt(proteinGrams), slugs);
    const macros = calculateMacros(baseSlug, parseInt(proteinGrams));
    ok(res, { price, macros, pricePerServing: parseFloat((price / 30).toFixed(2)) });
  } catch (e) { err(res, e.message); }
});

// ─── CUSTOMERS ────────────────────────────────────────────────────────────────

// POST /api/v1/customers
// Create or retrieve customer (upsert on email).
router.post('/customers', async (req, res) => {
  try {
    const schema = z.object({
      email:        z.string().email(),
      firstName:    z.string(),
      lastName:     z.string(),
      addressLine1: z.string().optional(),
      city:         z.string().optional(),
      state:        z.string().optional(),
      postalCode:   z.string().optional(),
      country:      z.string().default('MX'),
    });
    const data = validate(schema, req.body);

    let customer = await prisma.customer.findUnique({ where: { email: data.email } });
    if (!customer) {
      const stripeCustomer = await stripe.customers.create({
        email: data.email,
        name:  `${data.firstName} ${data.lastName}`,
      });
      customer = await prisma.customer.create({
        data: { ...data, stripeCustomerId: stripeCustomer.id },
      });
    }
    ok(res, customer, 201);
  } catch (e) { err(res, e.message); }
});

// ─── CHECKOUT ─────────────────────────────────────────────────────────────────

// POST /api/v1/checkout/intent
// Create a Stripe PaymentIntent. Frontend confirms it with the card.
router.post('/checkout/intent', requireAuth, async (req, res) => {
  try {
    const schema = z.object({
      blendSpecId:      z.string().uuid(),
      billingInterval:  z.enum(['MONTHLY', 'QUARTERLY', 'ONETIME']),
    });
    const { blendSpecId, billingInterval } = validate(schema, req.body);
    const spec = await BlendSpecService.getById(blendSpecId);

    let amount = spec.priceMonthly;
    if (billingInterval === 'QUARTERLY') amount = parseFloat((spec.priceMonthly * 3 * 0.9).toFixed(2));
    if (billingInterval === 'ONETIME')   amount = parseFloat((spec.priceMonthly * 1.18).toFixed(2));

    const intent = await stripe.paymentIntents.create({
      amount:   Math.round(amount * 100),
      currency: 'usd',
      customer: req.customer.stripeCustomerId,
      metadata: { blend_spec_id: blendSpecId, billing_interval: billingInterval },
    });

    ok(res, { clientSecret: intent.client_secret, amount });
  } catch (e) { err(res, e.message); }
});

// POST /api/v1/checkout/quick-intent
// Guest checkout: creates customer, blend spec, and payment intent in one call.
// No auth required. Used by the frontend for the MVP flow.
router.post('/checkout/quick-intent', async (req, res) => {
  try {
    const schema = z.object({
      firstName:       z.string().min(1),
      lastName:        z.string().min(1),
      email:           z.string().email(),
      addressLine1:    z.string().optional(),
      city:            z.string().optional(),
      postalCode:      z.string().optional(),
      country:         z.string().default('US'),
      baseSlug:        z.string(),
      flavorSlug:      z.string(),
      proteinGrams:    z.number(),
      addInSlugs:      z.array(z.string()).default([]),
      quizAnswers:     z.record(z.unknown()).optional(),
      billingInterval: z.enum(['MONTHLY', 'QUARTERLY', 'ONETIME']).default('MONTHLY'),
      amount:          z.number(),
    });

    const data = validate(schema, req.body);

    // 1. Upsert customer
    let customer = await prisma.customer.findUnique({ where: { email: data.email } });
    if (!customer) {
      const stripeCustomer = await stripe.customers.create({
        email: data.email,
        name:  `${data.firstName} ${data.lastName}`,
      });
      customer = await prisma.customer.create({
        data: {
          email:           data.email,
          firstName:       data.firstName,
          lastName:        data.lastName,
          stripeCustomerId: stripeCustomer.id,
          addressLine1:    data.addressLine1 ?? null,
          city:            data.city ?? null,
          postalCode:      data.postalCode ?? null,
          country:         data.country,
        },
      });
    }

    // 2. Create blend spec
    const spec = await BlendSpecService.create({
      baseSlug:     data.baseSlug,
      flavorSlug:   data.flavorSlug,
      proteinGrams: data.proteinGrams,
      addInSlugs:   data.addInSlugs,
      quizAnswers:  data.quizAnswers,
    });

    // 3. Create Stripe payment intent
    const intent = await stripe.paymentIntents.create({
      amount:   data.amount,
      currency: 'usd',
      customer: customer.stripeCustomerId,
      metadata: {
        customer_id:      customer.id,
        blend_spec_id:    spec.id,
        billing_interval: data.billingInterval,
      },
    });

    ok(res, {
      clientSecret: intent.client_secret,
      customerId:   customer.id,
      blendSpecId:  spec.id,
      amount:       data.amount,
    });
  } catch (e) {
    console.error('[QuickIntent]', e.message);
    err(res, e.message);
  }
});

// ─── SUBSCRIPTIONS ────────────────────────────────────────────────────────────

// GET /api/v1/subscriptions
router.get('/subscriptions', requireAuth, async (req, res) => {
  try {
    const subs = await SubscriptionService.getByCustomer(req.customer.id);
    ok(res, subs);
  } catch (e) { err(res, e.message); }
});

// POST /api/v1/subscriptions/:id/modify
router.post('/subscriptions/:id/modify', requireAuth, async (req, res) => {
  try {
    const schema = z.object({
      baseSlug:     z.string().optional(),
      flavorSlug:   z.string().optional(),
      proteinGrams: z.number().optional(),
      addInSlugs:   z.array(z.string()).optional(),
    });
    const changes = validate(schema, req.body);
    const updated = await SubscriptionService.modifyNextBlend(req.params.id, changes, req.customer.id);
    ok(res, updated);
  } catch (e) { err(res, e.message); }
});

// POST /api/v1/subscriptions/:id/pause
router.post('/subscriptions/:id/pause', requireAuth, async (req, res) => {
  try {
    const schema = z.object({ resumeDate: z.string().datetime().optional() });
    const { resumeDate } = validate(schema, req.body);
    const updated = await SubscriptionService.pause(req.params.id, req.customer.id, resumeDate);
    ok(res, updated);
  } catch (e) { err(res, e.message); }
});

// POST /api/v1/subscriptions/:id/resume
router.post('/subscriptions/:id/resume', requireAuth, async (req, res) => {
  try {
    const updated = await SubscriptionService.resume(req.params.id, req.customer.id);
    ok(res, updated);
  } catch (e) { err(res, e.message); }
});

// POST /api/v1/subscriptions/:id/skip
router.post('/subscriptions/:id/skip', requireAuth, async (req, res) => {
  try {
    const updated = await SubscriptionService.skipNext(req.params.id, req.customer.id);
    ok(res, updated);
  } catch (e) { err(res, e.message); }
});

// POST /api/v1/subscriptions/:id/cancel
router.post('/subscriptions/:id/cancel', requireAuth, async (req, res) => {
  try {
    const schema = z.object({ reason: z.string().optional() });
    const { reason } = validate(schema, req.body);
    const updated = await SubscriptionService.requestCancellation(req.params.id, req.customer.id, reason);
    ok(res, updated);
  } catch (e) { err(res, e.message); }
});

// POST /api/v1/subscriptions/:id/undo-cancel
router.post('/subscriptions/:id/undo-cancel', requireAuth, async (req, res) => {
  try {
    const updated = await SubscriptionService.undoCancellation(req.params.id, req.customer.id);
    ok(res, updated);
  } catch (e) { err(res, e.message); }
});

// ─── ORDERS ───────────────────────────────────────────────────────────────────

// GET /api/v1/orders
router.get('/orders', requireAuth, async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      where:   { customerId: req.customer.id },
      include: { blendSpec: { include: { base: true, flavor: true } } },
      orderBy: { createdAt: 'desc' },
    });
    ok(res, orders);
  } catch (e) { err(res, e.message); }
});

// GET /api/v1/orders/:id
router.get('/orders/:id', requireAuth, async (req, res) => {
  try {
    const order = await prisma.order.findFirstOrThrow({
      where:   { id: req.params.id, customerId: req.customer.id },
      include: { blendSpec: { include: { base: true, flavor: true, addIns: { include: { addIn: true } } } } },
    });
    ok(res, order);
  } catch (e) { err(res, e.message, 404); }
});

// ─── STRIPE WEBHOOK ───────────────────────────────────────────────────────────
// Raw body is required for signature verification.
// Mount this BEFORE express.json() in src/index.js.

export async function stripeWebhookHandler(req, res) {
  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (e) {
    console.error('[Stripe] Webhook signature verification failed:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  console.log(`[Stripe] Event: ${event.type}`);

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      const subId = pi.metadata?.subscription_id;
      if (subId) await SubscriptionService.markPaymentRecovered(subId).catch(()=>{});
      break;
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object;
      const subId = pi.metadata?.subscription_id;
      if (subId) await SubscriptionService.markPaymentFailed(subId, pi.last_payment_error?.message ?? 'unknown').catch(()=>{});
      break;
    }
    case 'customer.subscription.deleted': {
      const stripeSub = event.data.object;
      const sub = await prisma.subscription.findFirst({ where: { stripeSubscriptionId: stripeSub.id } });
      if (sub) await SubscriptionService.finalizeCancellation(sub.id, 'stripe_subscription_deleted').catch(()=>{});
      break;
    }
    default:
      console.log(`[Stripe] Unhandled event type: ${event.type}`);
  }

  res.json({ received: true });
}

export default router;
