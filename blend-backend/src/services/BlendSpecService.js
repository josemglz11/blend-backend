// src/services/BlendSpecService.js
// Creates, prices, and validates BlendSpec objects.
// The BlendSpec is the canonical object in the system.
// Everything else (subscriptions, orders, fulfillment) references it.

import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

const prisma = new PrismaClient();

// ─── VALIDATION SCHEMA ────────────────────────────────────────────────────────

export const BlendSpecInputSchema = z.object({
  baseSlug:     z.enum(['whey_isolate', 'vegan_blend', 'casein', 'whey']).transform(v => v === 'whey' ? 'whey_isolate' : v),
  flavorSlug:   z.enum(['chocolate', 'vanilla', 'strawberry', 'coffee', 'unflavored', 'cookies_cream']),
  proteinGrams: z.union([z.literal(20), z.literal(25), z.literal(30)]),
  addInSlugs:   z.array(z.string()).max(5).default([]),
  quizAnswers:  z.record(z.unknown()).optional(),
  quizVersion:  z.string().optional(),
});

// ─── PRICING ENGINE ───────────────────────────────────────────────────────────
// All prices in USD. Monthly subscription price.

const BASE_PRICES = {
  whey_isolate: 29.99,
  vegan_blend:  32.99,
  casein:       31.99,
};

const DOSE_ADJUSTMENTS = {
  20: 0,
  25: 2.00,
  30: 4.00,
};

// These are also stored in the DB but kept here for fast calculation
// without a round-trip during the configurator's live pricing.
const ADDIN_PRICES = {
  creatine:     8.00,
  electrolytes: 7.00,
  enzymes:      6.00,
  greens:       9.00,
  recovery:    10.00,
};

export function calculatePrice(baseSlug, proteinGrams, addInSlugs) {
  const base  = BASE_PRICES[baseSlug] ?? 29.99;
  const dose  = DOSE_ADJUSTMENTS[proteinGrams] ?? 2.00;
  const addins = addInSlugs.reduce((sum, slug) => sum + (ADDIN_PRICES[slug] ?? 0), 0);
  return parseFloat((base + dose + addins).toFixed(2));
}

// ─── MACRO CALCULATOR ─────────────────────────────────────────────────────────

const BASE_MACROS_AT_25G = {
  whey_isolate: { cal: 110, carbs: 2,  fat: 1  },
  vegan_blend:  { cal: 120, carbs: 5,  fat: 2  },
  casein:       { cal: 120, carbs: 4,  fat: 2  },
};

export function calculateMacros(baseSlug, proteinGrams) {
  const base   = BASE_MACROS_AT_25G[baseSlug] ?? BASE_MACROS_AT_25G.whey_isolate;
  const ratio  = proteinGrams / 25;
  return {
    caloriesPerServing: Math.round(base.cal * ratio),
    carbsPerServing:    parseFloat((base.carbs * ratio).toFixed(1)),
    fatPerServing:      parseFloat((base.fat   * ratio).toFixed(1)),
  };
}

// ─── BLEND SPEC SERVICE ───────────────────────────────────────────────────────

export class BlendSpecService {

  // Create a new BlendSpec from validated input.
  // This is called both from the quiz recommendation flow
  // and from the configurator's manual customization.
  async create(input, ruleSetVersion = '1.0.0') {
    const parsed = BlendSpecInputSchema.parse(input);

    const [base, flavor, addIns] = await Promise.all([
      prisma.proteinBase.findUniqueOrThrow({ where: { slug: parsed.baseSlug } }),
      prisma.flavor.findUniqueOrThrow({ where: { slug: parsed.flavorSlug } }),
      prisma.addIn.findMany({ where: { slug: { in: parsed.addInSlugs } } }),
    ]);

    const macros = calculateMacros(parsed.baseSlug, parsed.proteinGrams);
    const price  = calculatePrice(parsed.baseSlug, parsed.proteinGrams, parsed.addInSlugs);

    const spec = await prisma.blendSpec.create({
      data: {
        baseId:            base.id,
        flavorId:          flavor.id,
        proteinGrams:      parsed.proteinGrams,
        servingsPerBag:    30,
        caloriesPerServing: macros.caloriesPerServing,
        carbsPerServing:   macros.carbsPerServing,
        fatPerServing:     macros.fatPerServing,
        priceMonthly:      price,
        quizAnswers:       parsed.quizAnswers ?? null,
        quizVersion:       parsed.quizVersion ?? '1.0.0',
        ruleSetVersion,
        addIns: {
          create: addIns.map(a => ({ addInId: a.id })),
        },
      },
      include: {
        base:   true,
        flavor: true,
        addIns: { include: { addIn: true } },
      },
    });

    return this.format(spec);
  }

  // Return a BlendSpec by ID, formatted.
  async getById(id) {
    const spec = await prisma.blendSpec.findUniqueOrThrow({
      where: { id },
      include: {
        base:   true,
        flavor: true,
        addIns: { include: { addIn: true } },
      },
    });
    return this.format(spec);
  }

  // Clone a BlendSpec with modifications.
  // Used when a subscriber changes their blend mid-cycle.
  async cloneWithChanges(sourceId, changes) {
    const source = await this.getById(sourceId);
    return this.create({
      baseSlug:     changes.baseSlug     ?? source.base.slug,
      flavorSlug:   changes.flavorSlug   ?? source.flavor.slug,
      proteinGrams: changes.proteinGrams ?? source.proteinGrams,
      addInSlugs:   changes.addInSlugs   ?? source.addIns.map(a => a.slug),
      quizAnswers:  source.quizAnswers,
      quizVersion:  source.quizVersion,
    });
  }

  // Formatted output used throughout the system.
  format(spec) {
    return {
      id:              spec.id,
      version:         spec.version,
      ruleSetVersion:  spec.ruleSetVersion,
      base: {
        id:   spec.base.id,
        slug: spec.base.slug,
        name: spec.base.name,
      },
      flavor: {
        id:   spec.flavor.id,
        slug: spec.flavor.slug,
        name: spec.flavor.name,
      },
      proteinGrams:      spec.proteinGrams,
      servingsPerBag:    spec.servingsPerBag,
      caloriesPerServing: spec.caloriesPerServing,
      carbsPerServing:   spec.carbsPerServing,
      fatPerServing:     spec.fatPerServing,
      priceMonthly:      parseFloat(spec.priceMonthly),
      addIns:            spec.addIns.map(a => ({
        id:    a.addIn.id,
        slug:  a.addIn.slug,
        name:  a.addIn.name,
        price: parseFloat(a.addIn.pricePerBag),
      })),
      quizAnswers:  spec.quizAnswers,
      quizVersion:  spec.quizVersion,
      createdAt:    spec.createdAt,
    };
  }

  // Replay a BlendSpec's quiz answers against any rule set version.
  // Used in customer support to answer "why did we recommend this."
  replayQuizAnswers(quizAnswers, ruleSetVersion = '1.0.0') {
    // In production, import the versioned rule set by ruleSetVersion.
    // For now, proxy to the current engine.
    const RecommendationEngine = require('./RecommendationEngine.js');
    return RecommendationEngine.recommend(quizAnswers);
  }
}

export default new BlendSpecService();
