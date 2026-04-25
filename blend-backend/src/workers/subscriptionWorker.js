// src/workers/subscriptionWorker.js
// Scheduled workers that drive the subscription lifecycle forward.
// These run on a cron schedule, not on user requests.
// Each worker is idempotent: running it twice has the same effect as once.

import cron        from 'node-cron';
import SubscriptionService from '../services/SubscriptionService.js';
import OrderService        from '../services/OrderService.js';
import { PrismaClient }    from '@prisma/client';
import Stripe              from 'stripe';

const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ─── SHIP WORKER ─────────────────────────────────────────────────────────────
// Runs daily at 6am UTC.
// Finds subscriptions due for shipment, charges the card,
// creates the Order with a pick-pack doc, and advances the subscription.

async function runShipWorker() {
  console.log('[ShipWorker] Starting...');
  const due = await SubscriptionService.getDueForShipment();
  console.log(`[ShipWorker] ${due.length} subscription(s) due.`);

  for (const sub of due) {
    try {
      // 1. Charge via Stripe.
      const price = parseFloat(sub.blendSpec.priceMonthly);
      const amountCents = Math.round(price * 100);

      let paymentSucceeded = false;

      try {
        await stripe.paymentIntents.create({
          amount:               amountCents,
          currency:             'usd',
          customer:             sub.customer.stripeCustomerId,
          payment_method:       sub.stripePaymentMethodId,
          confirm:              true,
          off_session:          true,
          description:          `BLEND subscription ${sub.id} cycle`,
          metadata: {
            subscription_id:  sub.id,
            blend_spec_id:    sub.blendSpecId,
            customer_id:      sub.customerId,
          },
        });
        paymentSucceeded = true;
      } catch (stripeErr) {
        console.error(`[ShipWorker] Payment failed for sub ${sub.id}:`, stripeErr.message);
        await SubscriptionService.markPaymentFailed(sub.id, stripeErr.message);
        // Notify customer via email (see EmailService).
        continue;
      }

      if (!paymentSucceeded) continue;

      // 2. Create the order with pick-pack doc.
      const order = await OrderService.createFromSubscription(sub);
      console.log(`[ShipWorker] Order ${order.orderNumber} created for sub ${sub.id}.`);

      // 3. If there was a pending modification, commit it.
      if (sub.status === 'ACTIVE_PENDING_MODIFICATION') {
        await SubscriptionService.commitPendingModification(sub.id);
      }

      // 4. Advance ship and billing dates.
      const { addMonths, addQuarters } = await import('date-fns');
      const now = new Date();
      const nextShip  = sub.billingInterval === 'QUARTERLY'
        ? addQuarters(now, 1) : addMonths(now, 1);
      const nextBill  = nextShip;

      await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          nextShipDate:         nextShip,
          nextBillingDate:      nextBill,
          totalCyclesCompleted: { increment: 1 },
        },
      });

      // 5. Send pick-pack doc to co-packer (stub: POST to webhook URL).
      await sendToCopackerWebhook(order);

    } catch (err) {
      console.error(`[ShipWorker] Unhandled error for sub ${sub.id}:`, err.message);
    }
  }

  console.log('[ShipWorker] Done.');
}

// ─── PAYMENT RETRY WORKER ─────────────────────────────────────────────────────
// Runs every 3 days at 8am UTC.
// Retries failed payments up to 4 times before finalizing cancellation.

async function runPaymentRetryWorker() {
  console.log('[PaymentRetryWorker] Starting...');
  const due = await SubscriptionService.getDueForPaymentRetry();

  for (const sub of due) {
    try {
      await stripe.paymentIntents.create({
        amount:        Math.round(parseFloat(sub.blendSpec?.priceMonthly ?? 44.99) * 100),
        currency:      'usd',
        customer:      sub.customer.stripeCustomerId,
        payment_method: sub.stripePaymentMethodId,
        confirm:       true,
        off_session:   true,
        description:   `BLEND payment recovery attempt ${sub.paymentRetryCount + 1}`,
      });
      await SubscriptionService.markPaymentRecovered(sub.id);
      console.log(`[PaymentRetryWorker] Recovered sub ${sub.id}.`);
    } catch (err) {
      const retryCount = sub.paymentRetryCount + 1;
      if (retryCount >= 4) {
        console.log(`[PaymentRetryWorker] Sub ${sub.id} exhausted retries. Canceling.`);
        await SubscriptionService.finalizeCancellation(sub.id, 'payment_failure_max_retries');
      } else {
        await SubscriptionService.markPaymentFailed(sub.id, err.message);
      }
    }
  }

  console.log('[PaymentRetryWorker] Done.');
}

// ─── AUTO-RESUME WORKER ───────────────────────────────────────────────────────
// Runs hourly. Resumes paused subscriptions whose resumeDate has passed.

async function runAutoResumeWorker() {
  const due = await SubscriptionService.getDueForAutoResume();
  for (const sub of due) {
    // System-driven resume, no userId check needed.
    await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status:     'ACTIVE',
        resumeDate: null,
        nextShipDate:    new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      },
    });
    // Emit event manually here since we bypass the service's auth check.
    await prisma.subscriptionEvent.create({
      data: {
        subscriptionId: sub.id,
        fromStatus:     'PAUSED',
        toStatus:       'ACTIVE',
        reason:         'auto_resume_date_reached',
        isUserDriven:   false,
      },
    });
    console.log(`[AutoResumeWorker] Resumed sub ${sub.id}.`);
  }
}

// ─── CANCELLATION FINALIZER ───────────────────────────────────────────────────
// Runs daily. Finalizes CANCEL_PENDING subscriptions past their billing date.

async function runCancellationFinalizer() {
  const due = await SubscriptionService.getDueForFinalCancellation();
  for (const sub of due) {
    await SubscriptionService.finalizeCancellation(sub.id, 'cancel_pending_period_ended');
    console.log(`[CancellationFinalizer] Finalized sub ${sub.id}.`);
  }
}

// ─── COPACKER WEBHOOK ─────────────────────────────────────────────────────────
// In production, POST the pick-pack doc to your co-packer's API or webhook.
// This is intentionally a stub so you can drop in your co-packer's integration.

async function sendToCopackerWebhook(order) {
  const webhookUrl = process.env.COPACKER_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log(`[Copacker] No webhook URL set. Order ${order.orderNumber} pick-pack doc saved to DB only.`);
    return;
  }

  try {
    const res = await fetch(webhookUrl, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.COPACKER_API_KEY}`,
      },
      body: JSON.stringify({
        order_number:     order.orderNumber,
        pick_pack_doc:    order.copackerPickPackDoc,
        blend_spec_id:    order.blendSpecId,
        customer_id:      order.customerId,
      }),
    });

    if (!res.ok) throw new Error(`Copacker webhook returned ${res.status}`);

    const data = await res.json();
    await OrderService.markSentToCopacker(order.id, data.copacker_order_id ?? order.orderNumber);
    console.log(`[Copacker] Order ${order.orderNumber} sent. Copacker ID: ${data.copacker_order_id}`);
  } catch (err) {
    console.error(`[Copacker] Failed to send order ${order.orderNumber}:`, err.message);
    // Do not throw. The order is already created. Retry logic can handle this.
  }
}

// ─── CRON REGISTRATION ────────────────────────────────────────────────────────

export function startWorkers() {
  // Ship worker: daily at 6am UTC
  cron.schedule('0 6 * * *', runShipWorker, { timezone: 'UTC' });

  // Payment retry: every 3 days at 8am UTC (Monday, Thursday)
  cron.schedule('0 8 * * 1,4', runPaymentRetryWorker, { timezone: 'UTC' });

  // Auto-resume: every hour
  cron.schedule('0 * * * *', runAutoResumeWorker, { timezone: 'UTC' });

  // Cancellation finalizer: daily at 7am UTC
  cron.schedule('0 7 * * *', runCancellationFinalizer, { timezone: 'UTC' });

  console.log('[Workers] All subscription workers registered.');
}

// Allow manual trigger for testing.
export { runShipWorker, runPaymentRetryWorker, runAutoResumeWorker, runCancellationFinalizer };
