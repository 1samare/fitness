import { describe, expect, test } from 'vitest';
import { reviewedPlanningDatasetV1Schema } from './reviewed-planning-dataset';

function createReviewedPlanningDatasetCandidate() {
  const dailyMenus = Array.from({ length: 7 }, (_, index) => ({
    id: `menu-${String(index + 1)}`,
    datasetVersion: 'dataset-v1',
    sourceId: 'source-v1',
    reviewedAt: '2026-08-01T00:00:00.000Z',
    qualityStatus: 'reviewed',
    meals: [
      { slot: 'breakfast', recipeTemplateVersionId: 'recipe-v1' },
      { slot: 'lunch', recipeTemplateVersionId: 'recipe-v1' },
      { slot: 'dinner', recipeTemplateVersionId: 'recipe-v1' }
    ]
  }));
  return {
    schemaVersion: 'reviewed-planning-dataset-v1',
    datasetId: 'dataset-v1',
    datasetVersion: 'dataset-v1',
    approvalStatus: 'approved',
    qualityStatus: 'reviewed',
    activatedAt: '2026-08-02T00:00:00.000Z',
    reviewedAt: '2026-08-01T00:00:00.000Z',
    validUntil: '2027-08-01T00:00:00.000Z',
    checksumSha256: '0'.repeat(64),
    sourceReferences: [{
      sourceId: 'source-v1',
      title: '授权来源',
      version: '2026',
      authorizationEvidenceRef: 'private-evidence/source-v1',
      cacheAllowed: true,
      displayAllowed: true,
      authorizationValidUntil: '2027-08-01T00:00:00.000Z',
      noExpiryBasis: null,
      exitDisposition: 'retain_historical_only'
    }],
    nutritionSnapshots: [{
      id: 'snapshot-v1',
      foodId: 'food-v1',
      canonicalNameZh: '测试食材',
      foodGroupId: 'other',
      sourceId: 'source-v1',
      sourceRecordId: 'record-v1',
      provider: 'offline-import',
      originalUnit: 'per_100_g_edible_portion',
      foodState: 'raw',
      datasetVersion: 'dataset-v1',
      snapshotVersion: 1,
      reviewedAt: '2026-08-01T00:00:00.000Z',
      qualityStatus: 'reviewed',
      allergens: [],
      nutrientsPer100g: {
        energyKcal: 100,
        proteinG: 10,
        fatG: 2,
        carbohydrateG: 10,
        fiberG: 2,
        saturatedFatG: 0.5,
        addedSugarG: 0
      }
    }],
    recipeTemplates: [{
      id: 'recipe-v1',
      templateId: 'recipe',
      version: 1,
      dishNameZh: '测试菜谱',
      sourceId: 'source-v1',
      datasetVersion: 'dataset-v1',
      reviewedAt: '2026-08-01T00:00:00.000Z',
      qualityStatus: 'reviewed',
      ingredients: [{ foodId: 'food-v1', nutritionSnapshotId: 'snapshot-v1', grams: 100 }]
    }],
    dailyMenus,
    menuCatalog: {
      id: 'catalog-v1',
      datasetVersion: 'dataset-v1',
      sourceId: 'source-v1',
      reviewedAt: '2026-08-01T00:00:00.000Z',
      qualityStatus: 'reviewed',
      dailyMenuTemplateVersionIds: dailyMenus.map((menu) => menu.id)
    }
  };
}

describe('reviewedPlanningDatasetV1Schema', () => {
  test('accepts a strict reviewed dataset envelope with exactly seven menus', () => {
    const candidate = createReviewedPlanningDatasetCandidate();

    expect(reviewedPlanningDatasetV1Schema.parse(candidate)).toEqual(candidate);
  });

  test('rejects unknown fields and non-reviewed records', () => {
    const withUnknown = {
      ...createReviewedPlanningDatasetCandidate(),
      supplierPayload: 'must-not-enter-the-contract'
    };
    expect(() => reviewedPlanningDatasetV1Schema.parse(withUnknown)).toThrow();

    const fixtureRecord = createReviewedPlanningDatasetCandidate();
    const firstSnapshot = fixtureRecord.nutritionSnapshots[0];
    if (firstSnapshot === undefined) throw new Error('Expected nutrition snapshot fixture');
    firstSnapshot.qualityStatus = 'test_fixture';
    expect(() => reviewedPlanningDatasetV1Schema.parse(fixtureRecord)).toThrow();
  });

  test('requires approved/reviewed metadata and seven catalog entries', () => {
    const unapproved = createReviewedPlanningDatasetCandidate() as Record<string, unknown>;
    unapproved.approvalStatus = 'pending';
    expect(() => reviewedPlanningDatasetV1Schema.parse(unapproved)).toThrow();

    const sixMenus = createReviewedPlanningDatasetCandidate();
    sixMenus.dailyMenus.pop();
    sixMenus.menuCatalog.dailyMenuTemplateVersionIds.pop();
    expect(() => reviewedPlanningDatasetV1Schema.parse(sixMenus)).toThrow();
  });
});
