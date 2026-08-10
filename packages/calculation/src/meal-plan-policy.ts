export const WEEKLY_MEAL_SERVING_MULTIPLIERS = Object.freeze(
  Array.from({ length: 21 }, (_, index) => (50 + index * 5) / 100)
);

export const MEAL_PLAN_VALIDATION_V1 = Object.freeze({
  policyVersion: 'meal-plan-validation-v1' as const,
  sourceIds: ['CN-DRI-MACRO-2017'] as const,
  energyRelativeTolerance: 0.1,
  proteinRelativeTolerance: 0.1,
  effectiveDate: '2026-08-10',
  reviewedAt: '2026-08-10'
});

export const FOOD_DIVERSITY_POLICY_V1 = Object.freeze({
  policyVersion: 'food-diversity-policy-v1' as const,
  sourceIds: ['CNS-DIETARY-GUIDELINES-2022'] as const,
  minimumDistinctFoodsPerDay: 12,
  minimumCoreFoodGroupsPerDay: 5,
  minimumDistinctFoodsPerWeek: 25,
  effectiveDate: '2026-08-10',
  reviewedAt: '2026-08-10'
});

export const WEEKLY_MEAL_GENERATION_V1 = Object.freeze({
  policyVersion: 'weekly-meal-generation-v1' as const,
  sourceIds: ['CNS-DIETARY-GUIDELINES-2022', 'CN-DRI-MACRO-2017'] as const,
  effectiveDate: '2026-08-10',
  reviewedAt: '2026-08-10'
});
