import { describe, expect, it } from 'vitest';
import {
  dailyMenuCatalogVersionSchema,
  dailyMenuTemplateVersionSchema,
  nutritionDataSnapshotSchema,
  recipeTemplateVersionSchema
} from './nutrition';

const validSnapshot = {
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
};

const validTemplate = {
  id: 'recipe-version-fixture-bowl-v1',
  templateId: 'recipe-fixture-bowl',
  version: 1,
  dishNameZh: '测试三色碗',
  sourceId: 'FITNESS-TEST-FIXTURE-V1',
  datasetVersion: 'fixture-2026-08-10',
  reviewedAt: '2026-08-10T00:00:00.000Z',
  qualityStatus: 'test_fixture',
  ingredients: [{
    foodId: 'fixture-tofu',
    nutritionSnapshotId: 'snapshot-fixture-tofu-v1',
    grams: 100
  }]
};

const validDailyMenuCatalog = {
  id: 'daily-menu-catalog-fixture-week-v1',
  datasetVersion: 'fixture-2026-08-10',
  sourceId: 'FITNESS-TEST-FIXTURE-V2',
  reviewedAt: '2026-08-10T00:00:00.000Z',
  qualityStatus: 'test_fixture',
  dailyMenuTemplateVersionIds: Array.from(
    { length: 7 },
    (_, index) => `daily-menu-version-fixture-day-${String(index + 1)}-v1`
  )
};

const snapshotWithoutSourceRecord: Record<string, unknown> = { ...validSnapshot };
delete snapshotWithoutSourceRecord.sourceRecordId;

describe('nutrition runtime contracts', () => {
  it('accepts a complete traceable nutrition snapshot', () => {
    expect(nutritionDataSnapshotSchema.safeParse(validSnapshot).success).toBe(true);
  });

  it.each([
    ['missing source record', snapshotWithoutSourceRecord],
    ['unknown unit', { ...validSnapshot, originalUnit: 'serving' }],
    ['unknown food state', { ...validSnapshot, foodState: 'maybe-cooked' }],
    ['negative nutrient', {
      ...validSnapshot,
      nutrientsPer100g: { ...validSnapshot.nutrientsPer100g, proteinG: -1 }
    }],
    ['unknown property', { ...validSnapshot, supplierClaim: 'authoritative' }]
  ])('rejects %s', (_name, value) => {
    expect(nutritionDataSnapshotSchema.safeParse(value).success).toBe(false);
  });

  it('accepts a versioned recipe pinned to an exact snapshot', () => {
    expect(recipeTemplateVersionSchema.safeParse(validTemplate).success).toBe(true);
  });

  it('rejects duplicate food identities and non-positive grams in a template', () => {
    expect(recipeTemplateVersionSchema.safeParse({
      ...validTemplate,
      ingredients: [
        validTemplate.ingredients[0],
        { ...validTemplate.ingredients[0], nutritionSnapshotId: 'another-snapshot' }
      ]
    }).success).toBe(false);
    expect(recipeTemplateVersionSchema.safeParse({
      ...validTemplate,
      ingredients: [{ ...validTemplate.ingredients[0], grams: 0 }]
    }).success).toBe(false);
  });

  it('validates a fixed daily-menu catalog and rejects extra fields', () => {
    const catalog = dailyMenuCatalogVersionSchema.parse(validDailyMenuCatalog);
    expect(catalog.dailyMenuTemplateVersionIds).toHaveLength(7);
    expect(() => dailyMenuCatalogVersionSchema.parse({ ...catalog, userId: 'attacker' }))
      .toThrow();
  });

  it('rejects duplicate meal slots in a daily menu', () => {
    const menu = {
      id: 'menu-fixture-duplicate-slots-v1',
      datasetVersion: 'fixture-2026-08-10',
      sourceId: 'FITNESS-TEST-FIXTURE-V2',
      reviewedAt: '2026-08-10T00:00:00.000Z',
      qualityStatus: 'test_fixture',
      meals: [
        { slot: 'breakfast', recipeTemplateVersionId: 'recipe-version-fixture-rice-v1' },
        { slot: 'breakfast', recipeTemplateVersionId: 'recipe-version-fixture-oats-v1' },
        { slot: 'dinner', recipeTemplateVersionId: 'recipe-version-fixture-fish-v1' }
      ]
    };
    expect(dailyMenuTemplateVersionSchema.safeParse(menu).success).toBe(false);
  });
});
