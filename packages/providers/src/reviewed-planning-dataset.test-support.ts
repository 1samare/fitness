import type { ReviewedPlanningDatasetV1 } from '@fitness/contracts';

/** Synthetic reviewed graph used only by automated tests; it is never exported by the package. */
export const REVIEWED_DATASET_NOW = '2026-08-20T00:00:00.000Z';

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

export type MutableReviewedPlanningDataset = DeepMutable<ReviewedPlanningDatasetV1>;

export function createReviewedPlanningDatasetCandidate(): MutableReviewedPlanningDataset {
  const datasetVersion = 'reviewed-2026-08-20';
  const sourceId = 'LICENSED-SYNTHETIC-SOURCE-2026';
  const reviewedAt = '2026-08-01T00:00:00.000Z';
  const nutritionSnapshots: MutableReviewedPlanningDataset['nutritionSnapshots'] = [
    {
      id: 'snapshot-oats-v1',
      foodId: 'food-oats',
      canonicalNameZh: '燕麦',
      foodGroupId: 'grains_tubers',
      sourceId,
      sourceRecordId: 'source-oats',
      provider: 'licensed-offline-import',
      originalUnit: 'per_100_g_edible_portion',
      foodState: 'dry',
      datasetVersion,
      snapshotVersion: 1,
      reviewedAt,
      qualityStatus: 'reviewed',
      allergens: [],
      nutrientsPer100g: {
        energyKcal: 389,
        proteinG: 16.9,
        fatG: 6.9,
        carbohydrateG: 66.3,
        fiberG: 10.6,
        saturatedFatG: 1.2,
        addedSugarG: 0
      }
    },
    {
      id: 'snapshot-chicken-v1',
      foodId: 'food-chicken',
      canonicalNameZh: '鸡胸肉',
      foodGroupId: 'animal_protein',
      sourceId,
      sourceRecordId: 'source-chicken',
      provider: 'licensed-offline-import',
      originalUnit: 'per_100_g_edible_portion',
      foodState: 'cooked',
      datasetVersion,
      snapshotVersion: 1,
      reviewedAt,
      qualityStatus: 'reviewed',
      allergens: [],
      nutrientsPer100g: {
        energyKcal: 165,
        proteinG: 31,
        fatG: 3.6,
        carbohydrateG: 0,
        fiberG: 0,
        saturatedFatG: 1,
        addedSugarG: 0
      }
    },
    {
      id: 'snapshot-broccoli-v1',
      foodId: 'food-broccoli',
      canonicalNameZh: '西兰花',
      foodGroupId: 'vegetables',
      sourceId,
      sourceRecordId: 'source-broccoli',
      provider: 'licensed-offline-import',
      originalUnit: 'per_100_g_edible_portion',
      foodState: 'cooked',
      datasetVersion,
      snapshotVersion: 1,
      reviewedAt,
      qualityStatus: 'reviewed',
      allergens: [],
      nutrientsPer100g: {
        energyKcal: 35,
        proteinG: 2.4,
        fatG: 0.4,
        carbohydrateG: 7.2,
        fiberG: 3.3,
        saturatedFatG: 0.1,
        addedSugarG: 0
      }
    }
  ];
  const recipeTemplates: MutableReviewedPlanningDataset['recipeTemplates'] = [
    {
      id: 'recipe-breakfast-v1',
      templateId: 'recipe-breakfast',
      version: 1,
      dishNameZh: '燕麦早餐',
      sourceId,
      datasetVersion,
      reviewedAt,
      qualityStatus: 'reviewed',
      ingredients: [{ foodId: 'food-oats', nutritionSnapshotId: 'snapshot-oats-v1', grams: 80 }]
    },
    {
      id: 'recipe-lunch-v1',
      templateId: 'recipe-lunch',
      version: 1,
      dishNameZh: '鸡胸肉午餐',
      sourceId,
      datasetVersion,
      reviewedAt,
      qualityStatus: 'reviewed',
      ingredients: [{ foodId: 'food-chicken', nutritionSnapshotId: 'snapshot-chicken-v1', grams: 150 }]
    },
    {
      id: 'recipe-dinner-v1',
      templateId: 'recipe-dinner',
      version: 1,
      dishNameZh: '西兰花晚餐',
      sourceId,
      datasetVersion,
      reviewedAt,
      qualityStatus: 'reviewed',
      ingredients: [{ foodId: 'food-broccoli', nutritionSnapshotId: 'snapshot-broccoli-v1', grams: 200 }]
    }
  ];
  const dailyMenus: MutableReviewedPlanningDataset['dailyMenus'] = Array.from(
    { length: 7 },
    (_, index) => ({
    id: `menu-day-${String(index + 1)}-v1`,
    datasetVersion,
    sourceId,
    reviewedAt,
    qualityStatus: 'reviewed' as const,
    meals: [
      { slot: 'breakfast' as const, recipeTemplateVersionId: 'recipe-breakfast-v1' },
      { slot: 'lunch' as const, recipeTemplateVersionId: 'recipe-lunch-v1' },
      { slot: 'dinner' as const, recipeTemplateVersionId: 'recipe-dinner-v1' }
    ]
    })
  );

  return {
    schemaVersion: 'reviewed-planning-dataset-v1',
    datasetId: 'reviewed-planning-cn-v1',
    datasetVersion,
    approvalStatus: 'approved',
    qualityStatus: 'reviewed',
    activatedAt: '2026-08-02T00:00:00.000Z',
    reviewedAt,
    validUntil: '2027-08-01T00:00:00.000Z',
    checksumSha256: '0'.repeat(64),
    sourceReferences: [{
      sourceId,
      title: '合成审核数据源',
      version: '2026-08-01',
      authorizationEvidenceRef: 'private-evidence/license-2026',
      cacheAllowed: true,
      displayAllowed: true,
      authorizationValidUntil: '2027-08-01T00:00:00.000Z',
      noExpiryBasis: null,
      exitDisposition: 'retain_historical_only'
    }],
    nutritionSnapshots,
    recipeTemplates,
    dailyMenus,
    menuCatalog: {
      id: 'menu-catalog-v1',
      datasetVersion,
      sourceId,
      reviewedAt,
      qualityStatus: 'reviewed',
      dailyMenuTemplateVersionIds: dailyMenus.map((menu) => menu.id)
    }
  };
}
