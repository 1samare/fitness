import type { NutritionDataSnapshot, RecipeTemplateVersion } from '@fitness/domain';

const FIXTURE_METADATA = {
  sourceId: 'FITNESS-TEST-FIXTURE-V1',
  provider: 'fitness-test-fixture',
  originalUnit: 'per_100_g_edible_portion',
  datasetVersion: 'fixture-2026-08-10',
  snapshotVersion: 1,
  reviewedAt: '2026-08-10T00:00:00.000Z',
  qualityStatus: 'test_fixture'
} as const;

export const TEST_NUTRITION_SNAPSHOTS = Object.freeze([
  {
    id: 'snapshot-fixture-tofu-v1',
    foodId: 'fixture-tofu',
    canonicalNameZh: '测试豆腐',
    foodGroupId: 'soy_nuts',
    sourceRecordId: 'fixture-tofu-001',
    foodState: 'cooked',
    allergens: ['大豆'],
    nutrientsPer100g: {
      energyKcal: 100,
      proteinG: 10,
      fatG: 5,
      carbohydrateG: 4,
      fiberG: 2,
      saturatedFatG: 1,
      addedSugarG: 0
    },
    ...FIXTURE_METADATA
  },
  {
    id: 'snapshot-fixture-noodles-v1',
    foodId: 'fixture-noodles',
    canonicalNameZh: '测试面条',
    foodGroupId: 'grains_tubers',
    sourceRecordId: 'fixture-noodles-001',
    foodState: 'cooked',
    allergens: ['含麸质谷物'],
    nutrientsPer100g: {
      energyKcal: 120,
      proteinG: 2.5,
      fatG: 0.5,
      carbohydrateG: 26,
      fiberG: 0.5,
      saturatedFatG: 0.1,
      addedSugarG: 0
    },
    ...FIXTURE_METADATA
  },
  {
    id: 'snapshot-fixture-broccoli-v1',
    foodId: 'fixture-broccoli',
    canonicalNameZh: '测试西兰花',
    foodGroupId: 'vegetables',
    sourceRecordId: 'fixture-broccoli-001',
    foodState: 'cooked',
    allergens: [],
    nutrientsPer100g: {
      energyKcal: 30,
      proteinG: 3,
      fatG: 0.5,
      carbohydrateG: 5,
      fiberG: 3,
      saturatedFatG: 0.1,
      addedSugarG: 0
    },
    ...FIXTURE_METADATA
  }
] as const satisfies readonly NutritionDataSnapshot[]);

export const TEST_RECIPE_TEMPLATES = Object.freeze([
  {
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
  }
] as const satisfies readonly RecipeTemplateVersion[]);
