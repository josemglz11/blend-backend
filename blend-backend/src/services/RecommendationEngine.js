// src/services/RecommendationEngine.js
// Rules-table based recommendation engine.
// Rules are versioned data, not hardcoded logic.
// Each rule has: id, priority, condition function, effect function, reason string.
// Rules are evaluated in priority order (highest first).
// Hard constraints (allergy, vegan) use priority 100.
// Base recommendations use priority 50.
// Add-in suggestions use priority 25.
// Dosing uses priority 10.

// ─── RULE SET v1.0.0 ──────────────────────────────────────────────────────────

const RULE_SET_V1 = [

  // HARD CONSTRAINTS (priority 100)
  // These lock a value and mark it as non-overridable by lower-priority rules.

  {
    id: 'vegan_locks_base',
    priority: 100,
    condition: (a) => a.dietary === 'vegan',
    effect: (rec) => { rec.base = 'vegan_blend'; rec.baseLocked = true; },
    reason: () => 'Plant-based to match your dietary preference. Complete amino profile from pea, rice, and pumpkin.',
    applies_to: 'base',
  },
  {
    id: 'lactose_locks_base',
    priority: 100,
    condition: (a) => a.dietary === 'lactose',
    effect: (rec) => { rec.base = 'vegan_blend'; rec.baseLocked = true; },
    reason: () => 'Dairy-free formula to match your lactose intolerance.',
    applies_to: 'base',
  },

  // BASE RECOMMENDATIONS (priority 50)

  {
    id: 'before_bed_casein',
    priority: 50,
    condition: (a) => a.timing === 'before_bed' && !a._baseLocked,
    effect: (rec) => { if(!rec.baseLocked) rec.base = 'casein'; },
    reason: () => 'Slow-release casein feeds your muscles over 6 to 8 hours of sleep.',
    applies_to: 'base',
  },
  {
    id: 'post_workout_whey',
    priority: 50,
    condition: (a) => a.timing === 'post_workout' && !a._baseLocked,
    effect: (rec) => { if(!rec.baseLocked) rec.base = 'whey_isolate'; },
    reason: () => 'Fast-absorbing whey isolate delivers amino acids within 30 minutes of training.',
    applies_to: 'base',
  },
  {
    id: 'morning_whey',
    priority: 45,
    condition: (a) => a.timing === 'morning' && !a._baseLocked,
    effect: (rec) => { if(!rec.baseLocked) rec.base = 'whey_isolate'; },
    reason: () => 'Whey isolate mixes cleanly and absorbs fast for a morning routine.',
    applies_to: 'base',
  },
  {
    id: 'healthy_aging_casein',
    priority: 40,
    condition: (a) => a.goal === 'healthy_aging' && !a._baseLocked,
    effect: (rec) => { if(!rec.baseLocked) rec.base = 'casein'; },
    reason: () => 'Sustained protein release supports muscle maintenance throughout the day.',
    applies_to: 'base',
  },
  {
    id: 'default_whey',
    priority: 1,
    condition: () => true,
    effect: (rec) => { if(!rec.baseLocked && !rec.base) rec.base = 'whey_isolate'; },
    reason: () => 'Whey isolate is the cleanest, most versatile protein base for your goal.',
    applies_to: 'base',
  },

  // ADD-IN SUGGESTIONS (priority 25, composable)

  {
    id: 'strength_creatine',
    priority: 25,
    condition: (a) => ['strength', 'mixed'].includes(a.training),
    effect: (rec) => rec.addIns.add('creatine'),
    reason: (a) => `Creatine is the most evidence-backed supplement for ${a.training === 'strength' ? 'strength training' : 'mixed training'}. Increases power output and phosphocreatine stores.`,
    applies_to: 'addin',
  },
  {
    id: 'endurance_electrolytes',
    priority: 25,
    condition: (a) => ['endurance', 'mixed'].includes(a.training),
    effect: (rec) => rec.addIns.add('electrolytes'),
    reason: () => 'Replenishes sodium, potassium, and magnesium lost during long sessions.',
    applies_to: 'addin',
  },
  {
    id: 'stomach_issues_enzymes',
    priority: 25,
    condition: (a) => a.experience === 'yes_stomach',
    effect: (rec) => rec.addIns.add('enzymes'),
    reason: () => 'Digestive enzymes improve protein breakdown and reduce the bloating some people experience.',
    applies_to: 'addin',
  },
  {
    id: 'general_health_greens',
    priority: 20,
    condition: (a) => ['general_health', 'healthy_aging'].includes(a.goal),
    effect: (rec) => rec.addIns.add('greens'),
    reason: () => 'Daily micronutrient support from whole food sources. Supports immune function and energy.',
    applies_to: 'addin',
  },
  {
    id: 'aging_recovery',
    priority: 20,
    condition: (a) => a.goal === 'healthy_aging' || ['50to65', 'over65'].includes(a.age),
    effect: (rec) => rec.addIns.add('recovery'),
    reason: () => 'Magnesium glycinate improves sleep quality. Ashwagandha lowers cortisol after training.',
    applies_to: 'addin',
  },

  // DOSING (priority 10)

  {
    id: 'dose_by_bodyweight',
    priority: 10,
    condition: () => true,
    effect: (rec, a) => {
      const kg = a.weight
        ? (a.weight.unit === 'lbs' ? a.weight.val * 0.453592 : a.weight.val)
        : 75;
      const raw  = kg * 0.35;
      const snap = Math.round(raw / 5) * 5;
      rec.dose   = Math.min(30, Math.max(20, snap));
    },
    reason: (a) => {
      const kg = a.weight
        ? (a.weight.unit === 'lbs' ? Math.round(a.weight.val * 0.453592) : a.weight.val)
        : 75;
      return `Based on your body weight of ${kg}kg, this dose optimizes muscle protein synthesis without excess calories.`;
    },
    applies_to: 'dose',
  },

  // FLAVOR DEFAULTS (priority 5)

  {
    id: 'default_flavor',
    priority: 5,
    condition: () => true,
    effect: (rec) => { if(!rec.flavor) rec.flavor = 'chocolate'; },
    reason: () => 'Chocolate is the most popular starting flavor. You can always change it.',
    applies_to: 'flavor',
  },
];

// ─── ENGINE ───────────────────────────────────────────────────────────────────

export const CURRENT_RULE_SET_VERSION = '1.0.0';

export function recommend(answers, ruleSetVersion = CURRENT_RULE_SET_VERSION) {
  // For future: load versioned rule set by ruleSetVersion.
  const rules = RULE_SET_V1;

  const rec = {
    base:      null,
    baseLocked: false,
    flavor:    null,
    dose:      25,
    addIns:    new Set(),
    reasons:   [],
  };

  // Sort by priority descending, then evaluate.
  const sorted = [...rules].sort((a, b) => b.priority - a.priority);

  for (const rule of sorted) {
    if (rule.condition(answers, rec)) {
      rule.effect(rec, answers);
      rec.reasons.push({
        ruleId:      rule.id,
        applies_to:  rule.applies_to,
        reason:      rule.reason(answers, rec),
      });
    }
  }

  return {
    baseSlug:     rec.base     || 'whey_isolate',
    flavorSlug:   rec.flavor   || 'chocolate',
    proteinGrams: rec.dose,
    addInSlugs:   [...rec.addIns].slice(0, 3), // cap at 3 default add-ins
    reasons:      rec.reasons,
    ruleSetVersion,
  };
}

// ─── REASON SUMMARY ───────────────────────────────────────────────────────────
// Produces the human-readable "Why this blend" breakdown shown on the reveal screen.

export function buildReasonSummary(recommendation) {
  const summary = [];

  const baseReason = recommendation.reasons.find(r => r.applies_to === 'base');
  if (baseReason) summary.push({ type: 'base', reason: baseReason.reason });

  const doseReason = recommendation.reasons.find(r => r.applies_to === 'dose');
  if (doseReason) summary.push({ type: 'dose', reason: doseReason.reason });

  const addinReasons = recommendation.reasons.filter(r => r.applies_to === 'addin');
  addinReasons.forEach(r => summary.push({ type: 'addin', reason: r.reason }));

  return summary;
}

export default { recommend, buildReasonSummary, CURRENT_RULE_SET_VERSION };
