import { describe, expect, it } from 'vitest';
import type { RecipeCandidateInput } from '@fitness/domain';
import { evaluateRecipeCandidate } from './evaluate-recipe-candidate';

const snapshots = [
  {
    id: 'snapshot-fixture-tofu-v1',
    foodId: 'fixture-tofu',
    canonicalNameZh: '测试豆腐',
    foodGroupId: 'soy_nuts',
    sourceId: 'FITNESS-TEST-FIXTURE-V1',
    sourceRecordId: 'fixture-tofu-001',
    provider: 'fitness-test-fixture',
    originalUnit: 'per_100_g_edible_portion',
    foodState: 'cooked',
    datasetVersion: 'fixture-2026-08-10',
    snapshotVersion: 1,
    reviewedAt: '2026-08-10T00:00:00.000Z',
    qualityStatus: 'test_fixture',
    allergens: ['大豆'],
    nutrientsPer100g: {
      energyKcal: 100,
      proteinG: 10,
      fatG: 5,
      carbohydrateG: 4,
      fiberG: 2,
      saturatedFatG: 1,
      addedSugarG: 0
    }
  },
  {
    id: 'snapshot-fixture-noodles-v1',
    foodId: 'fixture-noodles',
    canonicalNameZh: '测试面条',
    foodGroupId: 'grains_tubers',
    sourceId: 'FITNESS-TEST-FIXTURE-V1',
    sourceRecordId: 'fixture-noodles-001',
    provider: 'fitness-test-fixture',
    originalUnit: 'per_100_g_edible_portion',
    foodState: 'cooked',
    datasetVersion: 'fixture-2026-08-10',
    snapshotVersion: 1,
    reviewedAt: '2026-08-10T00:00:00.000Z',
    qualityStatus: 'test_fixture',
    allergens: ['含麸质谷物'],
    nutrientsPer100g: {
      energyKcal: 120,
      proteinG: 2.5,
      fatG: 0.5,
      carbohydrateG: 26,
      fiberG: 0.5,
      saturatedFatG: 0.1,
      addedSugarG: 0
    }
  },
  {
    id: 'snapshot-fixture-broccoli-v1',
    foodId: 'fixture-broccoli',
    canonicalNameZh: '测试西兰花',
    foodGroupId: 'vegetables',
    sourceId: 'FITNESS-TEST-FIXTURE-V1',
    sourceRecordId: 'fixture-broccoli-001',
    provider: 'fitness-test-fixture',
    originalUnit: 'per_100_g_edible_portion',
    foodState: 'cooked',
    datasetVersion: 'fixture-2026-08-10',
    snapshotVersion: 1,
    reviewedAt: '2026-08-10T00:00:00.000Z',
    qualityStatus: 'test_fixture',
    allergens: [],
    nutrientsPer100g: {
      energyKcal: 30,
      proteinG: 3,
      fatG: 0.5,
      carbohydrateG: 5,
      fiberG: 3,
      saturatedFatG: 0.1,
      addedSugarG: 0
    }
  }
] as const;

const template = {
  id: 'recipe-version-fixture-bowl-v1',
  templateId: 'recipe-fixture-bowl',
  version: 1,
  dishNameZh: '测试三色碗',
  sourceId: 'FITNESS-TEST-FIXTURE-V1',
  datasetVersion: 'fixture-2026-08-10',
  reviewedAt: '2026-08-10T00:00:00.000Z',
  qualityStatus: 'test_fixture',
  ingredients: [
    { foodId: 'fixture-tofu', nutritionSnapshotId: 'snapshot-fixture-tofu-v1', grams: 50 },
    { foodId: 'fixture-noodles', nutritionSnapshotId: 'snapshot-fixture-noodles-v1', grams: 100 },
    { foodId: 'fixture-broccoli', nutritionSnapshotId: 'snapshot-fixture-broccoli-v1', grams: 150 }
  ]
} as const;

const inventory = [
  { foodId: 'fixture-tofu', availableGrams: 50 },
  { foodId: 'fixture-noodles', availableGrams: 100 },
  { foodId: 'fixture-broccoli', availableGrams: 150 }
] as const;

function evaluate(overrides: Partial<RecipeCandidateInput> = {}) {
  return evaluateRecipeCandidate({
    template,
    snapshots,
    inventory,
    allergens: [],
    avoidFoodIds: [],
    minimumDistinctFoodGroups: 3,
    allowTestFixtures: true,
    ...overrides
  });
}

describe('evaluateRecipeCandidate', () => {
  it('recomputes seven nutrients from per-100-g snapshots and actual grams', () => {
    expect(evaluate()).toEqual({
      kind: 'accepted',
      totals: {
        energyKcal: 215,
        proteinG: 12,
        fatG: 3.8,
        carbohydrateG: 35.5,
        fiberG: 6,
        saturatedFatG: 0.8,
        addedSugarG: 0
      },
      sourceSnapshotIds: [
        'snapshot-fixture-tofu-v1',
        'snapshot-fixture-noodles-v1',
        'snapshot-fixture-broccoli-v1'
      ],
      foodGroupIds: ['soy_nuts', 'grains_tubers', 'vegetables']
    });
  });

  it('rounds actual grams before recomputing nutrients', () => {
    const result = evaluate({
      template: {
        ...template,
        ingredients: [
          { ...template.ingredients[0], grams: 33.35 },
          ...template.ingredients.slice(1)
        ]
      },
      snapshots: [
        {
          ...snapshots[0],
          nutrientsPer100g: { ...snapshots[0].nutrientsPer100g, energyKcal: 200 }
        },
        ...snapshots.slice(1)
      ]
    });

    expect(result).toMatchObject({ kind: 'accepted' });
    if (result.kind !== 'accepted') throw new Error('expected accepted candidate');
    expect(result.totals.energyKcal).toBe(231.8);
  });

  it('merges repeated food grams before enforcing inventory', () => {
    const result = evaluate({
      template: {
        ...template,
        ingredients: [
          { foodId: 'fixture-tofu', nutritionSnapshotId: 'snapshot-fixture-tofu-v1', grams: 30 },
          { foodId: 'fixture-tofu', nutritionSnapshotId: 'snapshot-fixture-tofu-v1', grams: 30 },
          ...template.ingredients.slice(1)
        ]
      }
    });

    expect(result).toMatchObject({
      kind: 'infeasible',
      code: 'nutrition_constraints_infeasible'
    });
    if (result.kind !== 'infeasible') throw new Error('expected infeasible candidate');
    expect(result.conflicts).toContainEqual({
      code: 'inventory_insufficient',
      foodId: 'fixture-tofu',
      requiredGrams: 60,
      availableGrams: 50
    });
  });

  it('recomputes nutrients once from the merged grams of a repeated food', () => {
    const result = evaluate({
      template: {
        ...template,
        ingredients: [
          { foodId: 'fixture-tofu', nutritionSnapshotId: 'snapshot-fixture-tofu-v1', grams: 50 },
          { foodId: 'fixture-tofu', nutritionSnapshotId: 'snapshot-fixture-tofu-v1', grams: 50 },
          ...template.ingredients.slice(1)
        ]
      },
      inventory: [
        { foodId: 'fixture-tofu', availableGrams: 100 },
        ...inventory.slice(1)
      ],
      snapshots: [
        {
          ...snapshots[0],
          nutrientsPer100g: {
            energyKcal: 0.1,
            proteinG: 0,
            fatG: 0,
            carbohydrateG: 0,
            fiberG: 0,
            saturatedFatG: 0,
            addedSugarG: 0
          }
        },
        ...snapshots.slice(1)
      ]
    });

    expect(result).toEqual({
      kind: 'accepted',
      totals: {
        energyKcal: 165.1,
        proteinG: 7,
        fatG: 1.3,
        carbohydrateG: 33.5,
        fiberG: 5,
        saturatedFatG: 0.3,
        addedSugarG: 0
      },
      sourceSnapshotIds: [
        'snapshot-fixture-tofu-v1',
        'snapshot-fixture-noodles-v1',
        'snapshot-fixture-broccoli-v1'
      ],
      foodGroupIds: ['soy_nuts', 'grains_tubers', 'vegetables']
    });
  });

  it('never relaxes any allergen declared by a source snapshot', () => {
    for (const snapshot of snapshots) {
      for (const allergen of snapshot.allergens) {
        const result = evaluate({ allergens: [`  ${allergen}  `] });
        expect(result).toMatchObject({
          kind: 'infeasible',
          code: 'nutrition_constraints_infeasible'
        });
        if (result.kind !== 'infeasible') throw new Error('expected infeasible candidate');
        expect(result.conflicts).toContainEqual({
          code: 'allergen_detected',
          foodId: snapshot.foodId,
          allergen
        });
      }
    }
  });

  it.each([
    [
      'avoided food',
      { avoidFoodIds: ['fixture-noodles'] },
      { code: 'avoided_food', foodId: 'fixture-noodles' }
    ],
    [
      'insufficient inventory',
      { inventory: [{ foodId: 'fixture-tofu', availableGrams: 49 }, ...inventory.slice(1)] },
      { code: 'inventory_insufficient', foodId: 'fixture-tofu', requiredGrams: 50, availableGrams: 49 }
    ],
    [
      'food group diversity',
      { minimumDistinctFoodGroups: 4 },
      { code: 'food_diversity_insufficient', requiredCount: 4, actualCount: 3 }
    ],
    [
      'test fixture in production',
      { allowTestFixtures: false },
      { code: 'nutrition_snapshot_not_reviewed', foodId: 'fixture-tofu', snapshotId: 'snapshot-fixture-tofu-v1' }
    ]
  ])('returns a structured conflict for %s', (_name, overrides, conflict) => {
    const result = evaluate(overrides);
    expect(result).toMatchObject({
      kind: 'infeasible',
      code: 'nutrition_constraints_infeasible'
    });
    if (result.kind !== 'infeasible') throw new Error('expected infeasible candidate');
    expect(result.conflicts).toContainEqual(conflict);
  });

  it('rejects missing and mismatched source-chain snapshots', () => {
    const missing = evaluate({ snapshots: snapshots.slice(1) });
    expect(missing).toMatchObject({
      kind: 'infeasible',
      code: 'nutrition_constraints_infeasible'
    });
    if (missing.kind !== 'infeasible') throw new Error('expected infeasible candidate');
    expect(missing.conflicts).toContainEqual({
      code: 'nutrition_snapshot_missing',
      foodId: 'fixture-tofu',
      snapshotId: 'snapshot-fixture-tofu-v1'
    });
    const mismatched = evaluate({
      snapshots: [{ ...snapshots[0], foodId: 'different-food' }, ...snapshots.slice(1)]
    });
    expect(mismatched).toMatchObject({
      kind: 'infeasible',
      code: 'nutrition_constraints_infeasible'
    });
    if (mismatched.kind !== 'infeasible') throw new Error('expected infeasible candidate');
    expect(mismatched.conflicts).toContainEqual({
      code: 'nutrition_snapshot_identity_mismatch',
      foodId: 'fixture-tofu',
      snapshotId: 'snapshot-fixture-tofu-v1'
    });
  });
});
