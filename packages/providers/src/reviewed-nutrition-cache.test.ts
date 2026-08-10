import { describe, expect, it } from 'vitest';

interface Snapshot {
  readonly id: string;
  readonly foodId: string;
  readonly nutrientsPer100g: { readonly proteinG: number };
}

interface Cache {
  getSnapshot(snapshotId: string): Promise<Snapshot>;
}

interface CacheConstructor {
  new(options: { readonly mode: 'production' | 'test'; readonly snapshots: readonly unknown[] }): Cache;
}

async function cacheConstructor(): Promise<CacheConstructor> {
  const module: Record<string, unknown> = await import('./reviewed-nutrition-cache')
    .catch(() => ({}));
  const candidate = module.ReviewedNutritionCache;
  expect(candidate, 'ReviewedNutritionCache must be exported').toBeTypeOf('function');
  return candidate as CacheConstructor;
}

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
    const Constructor = await cacheConstructor();
    const cache = new Constructor({ mode: 'test', snapshots: [fixtureSnapshot] });
    const first = await cache.getSnapshot(fixtureSnapshot.id);
    expect(first).toEqual(fixtureSnapshot);
    (first.nutrientsPer100g as { proteinG: number }).proteinG = 999;
    expect((await cache.getSnapshot(fixtureSnapshot.id)).nutrientsPer100g.proteinG).toBe(10);
  });

  it.each([
    ['missing source metadata', (({ sourceRecordId: _, ...value }) => value)(fixtureSnapshot)],
    ['negative nutrition', {
      ...fixtureSnapshot,
      nutrientsPer100g: { ...fixtureSnapshot.nutrientsPer100g, proteinG: -1 }
    }]
  ])('rejects invalid unknown input: %s', async (_name, value) => {
    const Constructor = await cacheConstructor();
    expect(() => new Constructor({ mode: 'test', snapshots: [value] })).toThrowError(
      expect.objectContaining({ code: 'invalid_nutrition_snapshot' })
    );
  });

  it('rejects duplicate immutable snapshot IDs', async () => {
    const Constructor = await cacheConstructor();
    expect(() => new Constructor({
      mode: 'test',
      snapshots: [fixtureSnapshot, { ...fixtureSnapshot }]
    })).toThrowError(expect.objectContaining({ code: 'duplicate_reviewed_record' }));
  });

  it('rejects test fixtures and missing records in production mode', async () => {
    const Constructor = await cacheConstructor();
    const cache = new Constructor({ mode: 'production', snapshots: [fixtureSnapshot] });
    await expect(cache.getSnapshot(fixtureSnapshot.id)).rejects.toMatchObject({
      code: 'nutrition_snapshot_unavailable',
      snapshotId: fixtureSnapshot.id
    });
    await expect(cache.getSnapshot('missing')).rejects.toMatchObject({
      code: 'nutrition_snapshot_unavailable',
      snapshotId: 'missing'
    });
  });

  it('has no network, URL, credential, or request surface', async () => {
    const Constructor = await cacheConstructor();
    const cache = new Constructor({ mode: 'test', snapshots: [fixtureSnapshot] });
    expect(cache).not.toHaveProperty('fetch');
    expect(cache).not.toHaveProperty('request');
    expect(cache).not.toHaveProperty('url');
    expect(cache).not.toHaveProperty('apiKey');
  });
});
