import { describe, expect, it } from 'vitest';
import { DuplicateReviewedRecordError } from './reviewed-records';
import {
  InvalidNutritionSnapshotError,
  ReviewedNutritionCache
} from './reviewed-nutrition-cache';

const fixtureSnapshot = {
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

describe('ReviewedNutritionCache', () => {
  it('serves test fixtures only in explicit test mode and clones results', async () => {
    const cache = new ReviewedNutritionCache({ mode: 'test', snapshots: [fixtureSnapshot] });
    const first = await cache.getSnapshot(fixtureSnapshot.id);
    expect(first).toEqual(fixtureSnapshot);
    (first.nutrientsPer100g as { proteinG: number }).proteinG = 999;
    expect((await cache.getSnapshot(fixtureSnapshot.id)).nutrientsPer100g.proteinG).toBe(10);
  });

  it.each([
    ['missing source metadata', { ...fixtureSnapshot, sourceRecordId: undefined }],
    ['negative nutrition', {
      ...fixtureSnapshot,
      nutrientsPer100g: { ...fixtureSnapshot.nutrientsPer100g, proteinG: -1 }
    }]
  ])('rejects invalid unknown input: %s', (_name, value) => {
    expect(() => new ReviewedNutritionCache({ mode: 'test', snapshots: [value] }))
      .toThrowError(InvalidNutritionSnapshotError);
  });

  it('rejects duplicate immutable snapshot IDs', () => {
    expect(() => new ReviewedNutritionCache({
      mode: 'test',
      snapshots: [fixtureSnapshot, { ...fixtureSnapshot }]
    })).toThrowError(DuplicateReviewedRecordError);
  });

  it('rejects test fixtures and missing records in production mode', async () => {
    const cache = new ReviewedNutritionCache({
      mode: 'production',
      snapshots: [fixtureSnapshot]
    });
    await expect(cache.getSnapshot(fixtureSnapshot.id)).rejects.toMatchObject({
      code: 'nutrition_snapshot_unavailable',
      snapshotId: fixtureSnapshot.id
    });
    await expect(cache.getSnapshot('missing')).rejects.toMatchObject({
      code: 'nutrition_snapshot_unavailable',
      snapshotId: 'missing'
    });
  });

  it('has no network, URL, credential, or request surface', () => {
    const cache = new ReviewedNutritionCache({ mode: 'test', snapshots: [fixtureSnapshot] });
    expect(cache).not.toHaveProperty('fetch');
    expect(cache).not.toHaveProperty('request');
    expect(cache).not.toHaveProperty('url');
    expect(cache).not.toHaveProperty('apiKey');
  });

  it('resolves only normalized exact canonical names', async () => {
    const cache = new ReviewedNutritionCache({
      mode: 'test',
      snapshots: [{
        ...fixtureSnapshot,
        id: 'snapshot-fixture-rice-v1',
        foodId: 'fixture-rice',
        canonicalNameZh: '测试米饭',
        sourceRecordId: 'fixture-rice-001',
        allergens: []
      }]
    });
    await expect(cache.resolveCanonicalName('  测试米饭  ')).resolves.toMatchObject({
      foodId: 'fixture-rice',
      nutritionSnapshotId: 'snapshot-fixture-rice-v1'
    });
    await expect(cache.resolveCanonicalName('测试米')).resolves.toBeNull();
  });
});
