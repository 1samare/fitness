import { describe, expect, it } from 'vitest';
import type { NutritionTargetInput } from '@fitness/domain';
import { calculateNutritionTargets } from './calculate-nutrition-targets';

function calculate(overrides: Partial<NutritionTargetInput> = {}) {
  return calculateNutritionTargets({
    targetEnergyKcal: 2_000,
    weightKg: 70,
    sexCode: 0,
    goal: 'maintain',
    trainingKind: 'none',
    ...overrides
  });
}

describe('calculateNutritionTargets', () => {
  it.each([
    [{ sexCode: 0 as const, trainingKind: 'none' as const, goal: 'maintain' as const }, 65],
    [{ sexCode: 1 as const, trainingKind: 'none' as const, goal: 'maintain' as const }, 55],
    [{ sexCode: 0 as const, trainingKind: 'general_or_endurance' as const, goal: 'maintain' as const }, 98],
    [{ sexCode: 0 as const, trainingKind: 'regular_resistance' as const, goal: 'maintain' as const }, 112],
    [{ sexCode: 0 as const, trainingKind: 'none' as const, goal: 'muscle_gain' as const }, 112]
  ])('selects the protein branch for %o', (branch, expectedProteinG) => {
    expect(calculate(branch)).toMatchObject({
      kind: 'feasible',
      proteinG: expectedProteinG
    });
  });

  it('solves carbohydrate and fat together instead of assigning a remainder blindly', () => {
    expect(calculate()).toEqual(expect.objectContaining({
      kind: 'feasible',
      targetEnergyKcal: 2_000,
      proteinG: 65,
      fatG: 55.6,
      carbohydrateG: 310,
      proteinEnergyPercent: 13,
      fatEnergyPercent: 25,
      carbohydrateEnergyPercent: 62,
      fiberRangeG: { minInclusive: 25, maxInclusive: 30 },
      saturatedFatMaxExclusiveG: 22.2,
      addedSugarMaxExclusiveG: 49.9
    }));
  });

  it('keeps feasible outputs inside every macro boundary after rounding', () => {
    const result = calculate({
      targetEnergyKcal: 1_837,
      weightKg: 63.4,
      trainingKind: 'regular_resistance'
    });

    expect(result).toEqual(expect.objectContaining({ kind: 'feasible' }));
    if (typeof result !== 'object' || result === null || !('kind' in result) || result.kind !== 'feasible') {
      throw new Error('expected feasible nutrition target');
    }
    expect(result.proteinG).toBe(101.4);
    expect(result.fatEnergyPercent).toBeGreaterThanOrEqual(20);
    expect(result.fatEnergyPercent).toBeLessThanOrEqual(30);
    expect(result.carbohydrateEnergyPercent).toBeGreaterThanOrEqual(50);
    expect(result.carbohydrateEnergyPercent).toBeLessThanOrEqual(65);
    expect(result.carbohydrateG).toBeGreaterThanOrEqual(120);
    expect(result.saturatedFatMaxExclusiveG * 9).toBeLessThan(183.7);
    expect(result.addedSugarMaxExclusiveG * 4).toBeLessThan(183.7);
  });

  it('returns structured conflicts when the 120 g carbohydrate floor exceeds 65%E', () => {
    expect(calculate({
      targetEnergyKcal: 700,
      trainingKind: 'regular_resistance'
    })).toMatchObject({
      kind: 'infeasible',
      code: 'nutrition_constraints_infeasible',
      conflicts: expect.arrayContaining([
        {
          code: 'carbohydrate_minimum_exceeds_share_maximum',
          minimumG: 120,
          maximumByEnergyG: 113.8
        },
        expect.objectContaining({ code: 'macro_energy_intersection_empty' })
      ])
    });
  });

  it('stops when a fixed RNI would exceed the automatic 2.0 g/kg ceiling', () => {
    expect(calculate({ weightKg: 25, sexCode: 1 })).toMatchObject({
      kind: 'infeasible',
      code: 'nutrition_constraints_infeasible',
      conflicts: [{
        code: 'protein_automatic_max_exceeded',
        proteinG: 55,
        maximumG: 50
      }]
    });
  });

  it('returns the complete policy provenance with every numerical result', () => {
    expect(calculate()).toMatchObject({
      policy: {
        policyVersion: 'nutrition-policy-v1',
        sourceIds: [
          'CN-DRI-MACRO-2017',
          'PROTEIN-MORTON-2018',
          'ISSN-PROTEIN-2017'
        ],
        applicableAgeRange: { minInclusive: 18, maxInclusive: 45 },
        applicableBmiRange: { minInclusive: 18.5, maxExclusive: 24 },
        effectiveDate: '2026-08-10',
        reviewedAt: '2026-08-10'
      }
    });
  });
});
