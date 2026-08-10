import type { NutritionPolicyMetadata } from '@fitness/domain';

export const NUTRITION_POLICY_V1 = Object.freeze({
  policyVersion: 'nutrition-policy-v1',
  sourceIds: [
    'CN-DRI-MACRO-2017',
    'PROTEIN-MORTON-2018',
    'ISSN-PROTEIN-2017'
  ],
  applicableAgeRange: { minInclusive: 18, maxInclusive: 45 },
  applicableBmiRange: { minInclusive: 18.5, maxExclusive: 24 },
  effectiveDate: '2026-08-10',
  reviewedAt: '2026-08-10',
  protein: {
    noTrainingRniG: { male: 65, female: 55 },
    generalOrEndurancePerKg: 1.4,
    resistanceOrMuscleGainPerKg: 1.6,
    automaticMaxPerKg: 2
  },
  fatEnergyRange: { minInclusive: 0.2, midpoint: 0.25, maxInclusive: 0.3 },
  carbohydrateEnergyRange: { minInclusive: 0.5, maxInclusive: 0.65 },
  carbohydrateMinimumG: 120,
  fiberRangeG: { minInclusive: 25, maxInclusive: 30 },
  saturatedFatEnergyMaxExclusive: 0.1,
  addedSugarEnergyMaxExclusive: 0.1,
  kcalPerGram: { protein: 4, carbohydrate: 4, fat: 9 },
  rounding: {
    grams: 'nearest_tenth_half_up',
    percentage: 'nearest_tenth_half_up'
  }
} as const satisfies NutritionPolicyMetadata);
