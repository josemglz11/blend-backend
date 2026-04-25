// src/services/SubscriptionService.js
// Full subscription state machine.
// Every transition emits a SubscriptionEvent with prior state, new state,
// reason, and whether it was user-driven.
// Billing and fulfillment are gated by state, not managed inside this service.

import { PrismaClient } from '@prisma/client';
import { addDays, addMonths, addQuarters, isBefore, isAfter } from 'date-fns';
import BlendSpecService from './BlendSpecService.js';

const prisma = new PrismaClient();

// ─── VALID TRANSITIONS ────────────────────────────────────────────────────────
// State machine definition. Key = from state. Value = allowed to-states.

const VALID_TRANSITIONS = {
  ACTIVE:                       ['ACTIVE_PENDING_MODIFICATION', 'PAUSED', 'SKIP_NEXT', 'PAYMENT_FAILED', 'CANCEL_PENDING', 'CANCELED'],
  ACTIVE_PENDING_MODIFICATION:  ['ACTIVE', 'PAUSED', 'SKIP_NEXT', 'PAYMENT_FAILED', 'CANCEL_PENDING', 'CANCELED'],
  PAUSED:                       ['ACTIVE', 'CANCELED'],
  SKIP_NEXT:                    ['ACTIVE', 'PAUSED', 'CANCEL_PENDING', 'CANCELED'],
  PAYMENT_FAILED:               ['ACTIVE', 'CANCELED'],
  CANCEL_PENDING:               ['ACTIVE', 'CANCELED'],
  CANCELED:                     [],  // terminal
};

// ─── SUBSCRIPTION SERVICE ─────────────────────────────────────────────────────

export class SubscriptionService {

  // Create a new subscription after successful payment.
  async create({ customerId, blendSpecId, billingInterval, stripeSubscriptionId, stripePaymentMethodId }) {
    const now      = new Date();
    const nextShip = addDays(now, 3);  // ships within 3 business days
    const nextBill = billingInterval === 'QUARTERLY' ? addQuarters(now, 1) : addMonths(now, 1);

    const sub = await prisma.subscription.create({
      data: {
        customerId,
        blendSpecId,
        billingInterval,
        status:               'ACTIVE',
        nextShipDate:         nextShip,
        nextBillingDate:      nextBill,
        stripeSubscriptionId,
        stripePaymentMethodId,
        startedAt:            now,
      },
      include: { blendSpec: { include: { base: true, flavor: true, addIns: { include: { addIn: true } } } } },
    });

    await this._emitEvent(sub.id, null, 'ACTIVE', 'subscription_created', true, { billingInterval });

    return sub;
  }

  // User modifies their blend for the next shipment.
  // The canonical blendSpec does NOT change until the modified order ships.
  async modifyNextBlend(subscriptionId, blendChanges, userId) {
    const sub = await this._getOrThrow(subscriptionId);
    this._assertUserOwns(sub, userId);

    if (sub.status === 'CANCELED' || sub.status === 'CANCEL_PENDING') {
      throw new Error('Cannot modify a canceled subscription.');
    }

    // Clone the current spec with the requested changes.
    const newSpec = await BlendSpecService.cloneWithChanges(sub.blendSpecId, blendChanges);

    const prevStatus = sub.status;
    const updated = await prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        pendingBlendSpecId: newSpec.id,
        status: 'ACTIVE_PENDING_MODIFICATION',
      },
    });

    await this._emitEvent(
      subscriptionId,
      prevStatus,
      'ACTIVE_PENDING_MODIFICATION',
      'blend_modified_by_user',
      true,
      { newBlendSpecId: newSpec.id, changes: blendChanges }
    );

    return updated;
  }

  // Apply the pending modification after a shipment processes.
  // Called by the fulfillment worker, not user-driven.
  async commitPendingModification(subscriptionId) {
    const sub = await this._getOrThrow(subscriptionId);
    if (sub.status !== 'ACTIVE_PENDING_MODIFICATION') return sub;
    if (!sub.pendingBlendSpecId) return sub;

    const updated = await prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        blendSpecId:        sub.pendingBlendSpecId,
        pendingBlendSpecId: null,
        status:             'ACTIVE',
      },
    });

    await this._emitEvent(
      subscriptionId,
      'ACTIVE_PENDING_MODIFICATION',
      'ACTIVE',
      'pending_modification_committed',
      false,
      { committedSpecId: sub.pendingBlendSpecId }
    );

    return updated;
  }

  // User pauses subscription.
  async pause(subscriptionId, userId, resumeDate = null) {
    const sub = await this._getOrThrow(subscriptionId);
    this._assertUserOwns(sub, userId);
    this._assertTransitionValid(sub.status, 'PAUSED');

    const updated = await prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        status:      'PAUSED',
        resumeDate:  resumeDate ? new Date(resumeDate) : null,
        // Preserve pending modification through the pause.
      },
    });

    await this._emitEvent(subscriptionId, sub.status, 'PAUSED', 'paused_by_user', true, { resumeDate });
    return updated;
  }

  // Resume a paused subscription.
  // Must handle stale payment methods gracefully.
  async resume(subscriptionId, userId) {
    const sub = await this._getOrThrow(subscriptionId);
    this._assertUserOwns(sub, userId);
    this._assertTransitionValid(sub.status, 'ACTIVE');

    const now      = new Date();
    const nextShip = addDays(now, 3);
    const nextBill = sub.billingInterval === 'QUARTERLY'
      ? addQuarters(now, 1)
      : addMonths(now, 1);

    const updated = await prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        status:         'ACTIVE',
        resumeDate:     null,
        nextShipDate:   nextShip,
        nextBillingDate: nextBill,
      },
    });

    await this._emitEvent(subscriptionId, 'PAUSED', 'ACTIVE', 'resumed_by_user', true, {});
    return updated;
  }

  // User skips the next cycle only.
  // Modification is preserved through the skip.
  async skipNext(subscriptionId, userId) {
    const sub = await this._getOrThrow(subscriptionId);
    this._assertUserOwns(sub, userId);
    this._assertTransitionValid(sub.status, 'SKIP_NEXT');

    const nextShip = sub.billingInterval === 'QUARTERLY'
      ? addQuarters(sub.nextShipDate, 1)
      : addMonths(sub.nextShipDate, 1);

    const nextBill = sub.billingInterval === 'QUARTERLY'
      ? addQuarters(sub.nextBillingDate, 1)
      : addMonths(sub.nextBillingDate, 1);

    const updated = await prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        status:         'SKIP_NEXT',
        nextShipDate:   nextShip,
        nextBillingDate: nextBill,
        // pendingBlendSpecId is preserved
      },
    });

    await this._emitEvent(subscriptionId, sub.status, 'SKIP_NEXT', 'skipped_by_user', true, {
      newNextShipDate: nextShip,
    });

    return updated;
  }

  // After a skip cycle, auto-restore to ACTIVE (called by the ship worker).
  async restoreAfterSkip(subscriptionId) {
    const sub = await this._getOrThrow(subscriptionId);
    if (sub.status !== 'SKIP_NEXT') return sub;

    const updated = await prisma.subscription.update({
      where: { id: subscriptionId },
      data: { status: 'ACTIVE' },
    });

    await this._emitEvent(subscriptionId, 'SKIP_NEXT', 'ACTIVE', 'skip_cycle_elapsed', false, {});
    return updated;
  }

  // User requests cancellation. Takes effect at period end.
  async requestCancellation(subscriptionId, userId, reason = null) {
    const sub = await this._getOrThrow(subscriptionId);
    this._assertUserOwns(sub, userId);
    this._assertTransitionValid(sub.status, 'CANCEL_PENDING');

    const updated = await prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        status:              'CANCEL_PENDING',
        cancelAtPeriodEnd:   true,
        cancelRequestedAt:   new Date(),
      },
    });

    await this._emitEvent(subscriptionId, sub.status, 'CANCEL_PENDING', 'cancellation_requested', true, { reason });
    return updated;
  }

  // User reverses a cancellation request while still in CANCEL_PENDING.
  async undoCancellation(subscriptionId, userId) {
    const sub = await this._getOrThrow(subscriptionId);
    this._assertUserOwns(sub, userId);
    if (sub.status !== 'CANCEL_PENDING') throw new Error('No pending cancellation to undo.');

    const updated = await prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        status:            'ACTIVE',
        cancelAtPeriodEnd: false,
        cancelRequestedAt: null,
      },
    });

    await this._emitEvent(subscriptionId, 'CANCEL_PENDING', 'ACTIVE', 'cancellation_reversed', true, {});
    return updated;
  }

  // Execute final cancellation. Called by billing worker at period end,
  // or by payment failure worker after exhausted retries.
  async finalizeCancellation(subscriptionId, reason) {
    const sub = await this._getOrThrow(subscriptionId);
    this._assertTransitionValid(sub.status, 'CANCELED');

    const updated = await prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        status:            'CANCELED',
        cancelAtPeriodEnd: false,
      },
    });

    // BlendSpec is preserved for resurrection flows.
    await this._emitEvent(subscriptionId, sub.status, 'CANCELED', reason, false, {});
    return updated;
  }

  // ─── PAYMENT FAILURE HANDLING ───────────────────────────────────────────────

  async markPaymentFailed(subscriptionId, errorMessage) {
    const sub = await this._getOrThrow(subscriptionId);

    const updated = await prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        status:           'PAYMENT_FAILED',
        paymentFailedAt:  new Date(),
        paymentRetryCount: { increment: 1 },
        lastPaymentError: errorMessage,
      },
    });

    await this._emitEvent(subscriptionId, sub.status, 'PAYMENT_FAILED', 'stripe_payment_failed', false, {
      error: errorMessage,
      retryCount: updated.paymentRetryCount,
    });

    return updated;
  }

  async markPaymentRecovered(subscriptionId) {
    const sub = await this._getOrThrow(subscriptionId);

    const updated = await prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        status:            'ACTIVE',
        paymentFailedAt:   null,
        paymentRetryCount: 0,
        lastPaymentError:  null,
      },
    });

    await this._emitEvent(subscriptionId, 'PAYMENT_FAILED', 'ACTIVE', 'payment_recovered', false, {});
    return updated;
  }

  // ─── QUERIES ────────────────────────────────────────────────────────────────

  async getByCustomer(customerId) {
    return prisma.subscription.findMany({
      where: { customerId },
      include: {
        blendSpec: { include: { base: true, flavor: true, addIns: { include: { addIn: true } } } },
        events: { orderBy: { createdAt: 'desc' }, take: 10 },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Subscriptions due to ship on a given date. Used by the ship worker.
  async getDueForShipment(date = new Date()) {
    return prisma.subscription.findMany({
      where: {
        status: { in: ['ACTIVE', 'ACTIVE_PENDING_MODIFICATION'] },
        nextShipDate: { lte: date },
      },
      include: {
        customer: true,
        blendSpec: { include: { base: true, flavor: true, addIns: { include: { addIn: true } } } },
      },
    });
  }

  // Subscriptions with payment failure ready for a retry.
  async getDueForPaymentRetry() {
    return prisma.subscription.findMany({
      where: {
        status: 'PAYMENT_FAILED',
        paymentRetryCount: { lt: 4 },
        paymentFailedAt: { lte: addDays(new Date(), -3) }, // retry every 3 days
      },
      include: { customer: true },
    });
  }

  // Paused subscriptions with a resume date that has passed.
  async getDueForAutoResume() {
    return prisma.subscription.findMany({
      where: {
        status: 'PAUSED',
        resumeDate: { lte: new Date() },
      },
    });
  }

  // Subscriptions in CANCEL_PENDING past their billing date.
  async getDueForFinalCancellation() {
    return prisma.subscription.findMany({
      where: {
        status: 'CANCEL_PENDING',
        nextBillingDate: { lte: new Date() },
      },
    });
  }

  // ─── PRIVATE HELPERS ────────────────────────────────────────────────────────

  async _getOrThrow(id) {
    const sub = await prisma.subscription.findUnique({ where: { id } });
    if (!sub) throw new Error(`Subscription ${id} not found.`);
    return sub;
  }

  _assertUserOwns(sub, userId) {
    if (sub.customerId !== userId) throw new Error('Unauthorized.');
  }

  _assertTransitionValid(fromStatus, toStatus) {
    const allowed = VALID_TRANSITIONS[fromStatus] ?? [];
    if (!allowed.includes(toStatus)) {
      throw new Error(`Invalid transition: ${fromStatus} -> ${toStatus}`);
    }
  }

  async _emitEvent(subscriptionId, fromStatus, toStatus, reason, isUserDriven, metadata) {
    return prisma.subscriptionEvent.create({
      data: {
        subscriptionId,
        fromStatus: fromStatus ?? undefined,
        toStatus,
        reason,
        isUserDriven,
        metadata,
      },
    });
  }
}

export default new SubscriptionService();
