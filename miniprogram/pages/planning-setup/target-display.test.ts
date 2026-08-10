import { describe, expect, it } from 'vitest';

async function displayModule() {
  const module: Record<string, unknown> = await import('./target-display').catch(() => ({}));
  expect(module.nutritionTargetText, 'nutritionTargetText must be exported').toBeTypeOf('function');
  return module.nutritionTargetText as (target: unknown) => string;
}

const policy = {
  policyVersion: 'nutrition-policy-v1',
  sourceIds: ['CN-DRI-MACRO-2017', 'PROTEIN-MORTON-2018', 'ISSN-PROTEIN-2017'],
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
  rounding: { grams: 'nearest_tenth_half_up', percentage: 'nearest_tenth_half_up' }
} as const;

const supportedEnergy = {
  kind: 'supported',
  bmi: 22.86,
  estimatedBmrKcal: 1582,
  nonTrainingBaselineKcal: 2373,
  trainingNetKcal: 184,
  estimatedMaintenanceKcal: 2557,
  targetEnergyKcal: 2557,
  policy: {
    policyVersion: 'calculation-policy-v2',
    sourceIds: ['CN-BMR-2023', 'CN-DRI-MACRO-2017', 'MET-COMPENDIUM-2024'],
    applicableAgeRange: { minInclusive: 18, maxInclusive: 45 },
    applicableBmiRange: { minInclusive: 18.5, maxExclusive: 24 },
    rounding: { kcal: 'nearest_whole_half_up', bmi: 'nearest_hundredth_half_up' }
  },
  disclaimer: '初始估算，仅供一般健身与膳食规划参考，不构成医疗建议。'
} as const;

function target(nutrition: unknown) {
  return {
    kind: 'daily_nutrition_target_version',
    id: 'nutrition-target-1',
    version: 1,
    createdAt: '2026-08-10T00:00:00.000Z',
    businessDate: '2026-08-11',
    bodyProfileVersionId: 'profile-1',
    goalVersionId: 'goal-1',
    trainingPlanVersionId: 'plan-1',
    dailyEnergyTargetVersionId: 'energy-target-1',
    energyPolicyVersion: 'calculation-policy-v2',
    nutritionPolicyVersion: 'nutrition-policy-v1',
    energy: supportedEnergy,
    nutrition
  };
}

describe('nutrition target display', () => {
  it('shows traceable estimates and every user-facing nutrition boundary', async () => {
    const nutritionTargetText = await displayModule();
    const text = nutritionTargetText(target({
      kind: 'feasible',
      targetEnergyKcal: 2557,
      proteinG: 112,
      fatG: 71,
      carbohydrateG: 367.4,
      proteinEnergyPercent: 17.5,
      fatEnergyPercent: 25,
      carbohydrateEnergyPercent: 57.5,
      fiberRangeG: { minInclusive: 25, maxInclusive: 30 },
      saturatedFatMaxExclusiveG: 28.4,
      addedSugarMaxExclusiveG: 63.9,
      policy
    }));

    expect(text).toBe('2557 kcal（估算） · 蛋白质 112 g · 脂肪 71 g · 碳水 367.4 g · 纤维 25–30 g · 饱和脂肪 <28.4 g · 添加糖 <63.9 g');
    expect(text).not.toMatch(/精准|医学级/);
  });

  it('shows explicit unsupported and infeasible states without inventing values', async () => {
    const nutritionTargetText = await displayModule();
    expect(nutritionTargetText({ ...target(null), energy: { kind: 'unsupported' } }))
      .toBe('暂不支持个性化能量与营养目标');
    expect(nutritionTargetText(target({
      kind: 'infeasible',
      code: 'nutrition_constraints_infeasible',
      conflicts: [{
        code: 'macro_energy_intersection_empty',
        minimumCarbohydrateKcal: 1_000,
        maximumCarbohydrateKcal: 900
      }],
      targetEnergyKcal: 2557,
      policy
    }))).toBe('2557 kcal（估算） · 营养约束无可行解');
  });
});
