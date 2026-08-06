export const CALCULATION_POLICY_V2 = Object.freeze({
  policyVersion: 'calculation-policy-v2' as const,
  sourceIds: ['CN-BMR-2023', 'CN-DRI-MACRO-2017'] as const,
  applicableAgeRange: { minInclusive: 18 as const, maxInclusive: 45 as const },
  applicableBmiRange: { minInclusive: 18.5 as const, maxExclusive: 24 as const },
  bmr: { weightCoefficient: 14.52, sexCoefficient: -155.88, intercept: 565.79 },
  pal: { light: 1.5, moderate: 1.75, heavy: 2 },
  goalAdjustment: { maintain: 0, fat_loss: -0.1, muscle_gain: 0.05 },
  effectiveDate: '2026-07-30',
  reviewedAt: '2026-07-30',
  rounding: {
    kcal: 'nearest_whole_half_up' as const,
    bmi: 'nearest_hundredth_half_up' as const
  }
});
