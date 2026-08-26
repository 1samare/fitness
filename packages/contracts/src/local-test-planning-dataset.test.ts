import { describe, expect, it } from 'vitest';
import { localTestPlanningDatasetV1Schema } from './local-test-planning-dataset';

function createCandidate() {
  const datasetVersion = 'local-test-2026-08-26';
  const sourceId = 'SYNTHETIC-TEST-SOURCE';
  const createdAt = '2026-08-26T00:00:00.000Z';
  const nutritionSnapshots = [{
    id: 'snapshot-oats-v1',
    foodId: 'food-oats',
    canonicalNameZh: '测试燕麦',
    foodGroupId: 'grains_tubers',
    sourceId,
    sourceRecordId: 'synthetic-oats',
    provider: 'bundled-test-fixture',
    originalUnit: 'per_100_g_edible_portion',
    foodState: 'dry',
    datasetVersion,
    snapshotVersion: 1,
    reviewedAt: createdAt,
    qualityStatus: 'test_fixture' as const,
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
  }];
  const recipeTemplates = [{
    id: 'recipe-breakfast-v1',
    templateId: 'recipe-breakfast',
    version: 1,
    dishNameZh: '测试燕麦早餐',
    sourceId,
    datasetVersion,
    reviewedAt: createdAt,
    qualityStatus: 'test_fixture' as const,
    ingredients: [{ foodId: 'food-oats', nutritionSnapshotId: 'snapshot-oats-v1', grams: 80 }]
  }];
  const dailyMenus = Array.from({ length: 7 }, (_, index) => ({
    id: `menu-day-${String(index + 1)}-v1`,
    datasetVersion,
    sourceId,
    reviewedAt: createdAt,
    qualityStatus: 'test_fixture' as const,
    meals: [
      { slot: 'breakfast' as const, recipeTemplateVersionId: 'recipe-breakfast-v1' },
      { slot: 'lunch' as const, recipeTemplateVersionId: 'recipe-breakfast-v1' },
      { slot: 'dinner' as const, recipeTemplateVersionId: 'recipe-breakfast-v1' }
    ]
  }));

  return {
    schemaVersion: 'local-test-planning-dataset-v1' as const,
    datasetId: 'local-test-planning-cn-v1',
    datasetVersion,
    qualityStatus: 'test_fixture' as const,
    createdAt,
    checksumSha256: '0'.repeat(64),
    sourceReferences: [{
      sourceId,
      title: '仅供自动化与内部测试的合成数据',
      version: '2026-08-26',
      fixtureNotice: 'synthetic_test_data_only' as const
    }],
    nutritionSnapshots,
    recipeTemplates,
    dailyMenus,
    menuCatalog: {
      id: 'menu-catalog-v1',
      datasetVersion,
      sourceId,
      reviewedAt: createdAt,
      qualityStatus: 'test_fixture' as const,
      dailyMenuTemplateVersionIds: dailyMenus.map((menu) => menu.id)
    }
  };
}

describe('localTestPlanningDatasetV1Schema', () => {
  it('accepts a closed synthetic graph whose records are all test fixtures', () => {
    expect(localTestPlanningDatasetV1Schema.parse(createCandidate()).qualityStatus).toBe('test_fixture');
  });

  it('rejects a reviewed record inside a test fixture dataset', () => {
    const candidate = createCandidate();
    const invalid = {
      ...candidate,
      nutritionSnapshots: [{ ...candidate.nutritionSnapshots[0], qualityStatus: 'reviewed' }]
    };

    expect(localTestPlanningDatasetV1Schema.safeParse(invalid).success).toBe(false);
  });
});
