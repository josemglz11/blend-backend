// src/services/OrderService.js
// Creates orders, manages lifecycle, and generates the
// co-packer pick-and-pack fulfillment document.
// The pick-pack doc is the canonical instruction set sent to your co-packer.
// It is stored as a JSON snapshot on the Order record.

import { PrismaClient } from '@prisma/client';
import { addDays }      from 'date-fns';
import { v4 as uuid }   from 'uuid';

const prisma = new PrismaClient();

// ─── ORDER SERVICE ────────────────────────────────────────────────────────────

export class OrderService {

  // Create an order from a subscription's current (or pending) BlendSpec.
  // Called by the ship worker after billing confirms payment.
  async createFromSubscription(subscription) {
    const spec       = subscription.blendSpec;
    const customer   = subscription.customer;
    const basePrice  = parseFloat(spec.priceMonthly);
    const addinPrice = spec.addIns.reduce((s, a) => s + parseFloat(a.addIn.pricePerBag), 0);
    const total      = parseFloat((basePrice + addinPrice).toFixed(2));

    const pickPackDoc = this._buildPickPackDoc(spec, customer, subscription);

    const order = await prisma.order.create({
      data: {
        orderNumber:        uuid().slice(0, 8).toUpperCase(),
        customerId:         customer.id,
        subscriptionId:     subscription.id,
        blendSpecId:        spec.id,
        status:             'PAID',
        basePrice:          spec.priceMonthly,
        addInsPrice:        addinPrice,
        totalPrice:         total,
        currency:           'USD',
        copackerPickPackDoc: pickPackDoc,
        shipToName:         `${customer.firstName} ${customer.lastName}`,
        shipToLine1:        customer.addressLine1,
        shipToLine2:        customer.addressLine2,
        shipToCity:         customer.city,
        shipToState:        customer.state,
        shipToPostal:       customer.postalCode,
        shipToCountry:      customer.country,
      },
    });

    return order;
  }

  // Create a one-time order (not tied to a subscription).
  async createOneTime({ customerId, blendSpecId, shippingAddress, stripePaymentIntentId }) {
    const [spec, customer] = await Promise.all([
      prisma.blendSpec.findUniqueOrThrow({
        where: { id: blendSpecId },
        include: { base: true, flavor: true, addIns: { include: { addIn: true } } },
      }),
      prisma.customer.findUniqueOrThrow({ where: { id: customerId } }),
    ]);

    const basePrice  = parseFloat(spec.priceMonthly) * 1.18; // one-time premium
    const addinPrice = spec.addIns.reduce((s, a) => s + parseFloat(a.addIn.pricePerBag), 0);
    const total      = parseFloat((basePrice + addinPrice).toFixed(2));

    const pickPackDoc = this._buildPickPackDoc(spec, customer, null);

    return prisma.order.create({
      data: {
        orderNumber:            uuid().slice(0, 8).toUpperCase(),
        customerId,
        blendSpecId,
        status:                 'PAID',
        basePrice,
        addInsPrice:            addinPrice,
        totalPrice:             total,
        currency:               'USD',
        stripePaymentIntentId,
        copackerPickPackDoc:    pickPackDoc,
        shipToName:             shippingAddress.name,
        shipToLine1:            shippingAddress.line1,
        shipToLine2:            shippingAddress.line2 ?? null,
        shipToCity:             shippingAddress.city,
        shipToState:            shippingAddress.state,
        shipToPostal:           shippingAddress.postal,
        shipToCountry:          shippingAddress.country,
      },
    });
  }

  // Mark order as sent to co-packer.
  async markSentToCopacker(orderId, copackerOrderId) {
    return prisma.order.update({
      where: { id: orderId },
      data: {
        status:           'SENT_TO_COPACKER',
        copackerOrderId,
        copackerSentAt:   new Date(),
      },
    });
  }

  async markShipped(orderId, trackingNumber, carrierCode) {
    return prisma.order.update({
      where: { id: orderId },
      data: {
        status:         'SHIPPED',
        trackingNumber,
        carrierCode,
        shippedAt:      new Date(),
      },
    });
  }

  async markDelivered(orderId) {
    return prisma.order.update({
      where: { id: orderId },
      data: { status: 'DELIVERED', deliveredAt: new Date() },
    });
  }

  // ─── PICK-AND-PACK DOCUMENT ─────────────────────────────────────────────────
  // This is the canonical fulfillment instruction set sent to your co-packer.
  // It is a complete snapshot of everything they need to produce and ship one bag.
  // Stored on the Order record so it is never mutated after creation.

  _buildPickPackDoc(spec, customer, subscription) {
    const baseSkuMap = {
      whey_isolate: 'SKU-BASE-WHEY-ISO-01',
      vegan_blend:  'SKU-BASE-VEGAN-BLD-01',
      casein:       'SKU-BASE-CASEIN-01',
    };

    const flavorSkuMap = {
      chocolate:   'SKU-FLV-CHOC-01',
      vanilla:     'SKU-FLV-VAN-01',
      strawberry:  'SKU-FLV-STRAW-01',
      coffee:      'SKU-FLV-COFF-01',
      unflavored:  'SKU-FLV-UNFV-01',
    };

    const addinSkuMap = {
      creatine:     'SKU-ADD-CREAT-5G-01',
      electrolytes: 'SKU-ADD-ELEC-01',
      enzymes:      'SKU-ADD-ENZ-01',
      greens:       'SKU-ADD-GRN-01',
      recovery:     'SKU-ADD-REC-01',
    };

    // Scoop size drives the base powder fill weight.
    const scoopWeightG = {
      20: 28,
      25: 34,
      30: 40,
    };

    const proteinG  = spec.proteinGrams;
    const fillWeightG = scoopWeightG[proteinG] * spec.servingsPerBag;
    const baseSku   = baseSkuMap[spec.base.slug];
    const flavorSku = flavorSkuMap[spec.flavor.slug];
    const addinSkus = spec.addIns.map(a => ({
      slug:     a.addIn.slug,
      sku:      addinSkuMap[a.addIn.slug],
      quantity: spec.servingsPerBag,  // 1 sachet per serving per add-in
      note:     `${a.addIn.name} sachet, 1 per serving, clip to bag`,
    }));

    return {
      doc_version:   '1.0',
      generated_at:  new Date().toISOString(),
      order_meta: {
        blend_spec_id:    spec.id,
        rule_set_version: spec.ruleSetVersion,
        subscription_id:  subscription?.id ?? null,
        is_subscription:  !!subscription,
        billing_interval: subscription?.billingInterval ?? 'ONETIME',
      },
      bag_assembly: {
        step: 'FILL_AND_SEAL',
        base_sku:           baseSku,
        base_name:          spec.base.name,
        flavor_sku:         flavorSku,
        flavor_name:        spec.flavor.name,
        fill_weight_grams:  fillWeightG,
        protein_per_scoop:  proteinG,
        servings_count:     spec.servingsPerBag,
        scoop_weight_grams: scoopWeightG[proteinG],
        notes: [
          `Fill ${fillWeightG}g of ${spec.base.name} (${baseSku}) pre-mixed with ${spec.flavor.name} flavor system (${flavorSku}).`,
          `Include scoop sized to ${scoopWeightG[proteinG]}g per serving.`,
          'Nitrogen flush before sealing.',
        ],
      },
      addins_assembly: addinSkus.length > 0 ? {
        step:    'SACHET_PACK',
        items:   addinSkus,
        notes: [
          `Pack ${addinSkus.length} sachet type(s) into the bag alongside the powder.`,
          'Group sachets with a biodegradable rubber band if more than 2 types.',
        ],
      } : null,
      label: {
        step:           'LABEL',
        customer_name:  `${customer.firstName} ${customer.lastName}`,
        blend_name:     _blendDisplayName(spec.base.slug),
        flavor:         spec.flavor.name,
        protein_grams:  proteinG,
        calories:       spec.caloriesPerServing,
        carbs:          spec.carbsPerServing,
        fat:            spec.fatPerServing,
        servings:       spec.servingsPerBag,
        addin_names:    spec.addIns.map(a => a.addIn.name),
        lot_code:       `${new Date().toISOString().slice(0,7).replace('-','')}-${spec.id.slice(0,6).toUpperCase()}`,
        best_by:        _addMonthsToNow(18),
        notes: [
          'Print label using template TMPL-BLEND-V1.',
          'Verify lot code matches batch record before applying.',
        ],
      },
      shipping: {
        step:        'SHIP',
        to_name:     `${customer.firstName} ${customer.lastName}`,
        to_line1:    customer.addressLine1,
        to_line2:    customer.addressLine2 ?? '',
        to_city:     customer.city,
        to_state:    customer.state,
        to_postal:   customer.postalCode,
        to_country:  customer.country,
        carrier:     customer.country === 'MX' ? 'DHL_MX' : 'USPS_PRIORITY',
        service:     customer.country === 'MX' ? 'DHL_EXPRESS_MX' : 'USPS_PRIORITY_MAIL',
        weight_kg:   parseFloat(((fillWeightG + 150) / 1000).toFixed(2)),  // powder + bag + sachets
        notes: [
          'Photograph bag and label before sealing outer box.',
          'Upload tracking number to BLEND portal within 1 hour of ship.',
        ],
      },
      qc_checklist: [
        { check: 'Base SKU matches order',           sku: baseSku },
        { check: 'Flavor SKU matches order',         sku: flavorSku },
        { check: 'Fill weight within +/-5g',         target: `${fillWeightG}g` },
        { check: 'Correct number of add-in sachets', count: addinSkus.reduce((s, a) => s + a.quantity, 0) },
        { check: 'Label lot code matches batch',     required: true },
        { check: 'Bag sealed and nitrogen-flushed',  required: true },
        { check: 'Shipping address matches order',   required: true },
      ],
    };
  }
}

function _blendDisplayName(baseSlug) {
  return { whey_isolate: 'APEX FORMULA', vegan_blend: 'TERRA BLEND', casein: 'NOCTURNE MIX' }[baseSlug] ?? 'BLEND';
}

function _addMonthsToNow(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

export default new OrderService();
