import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createReviewedPlanningDatasetCandidate,
  REVIEWED_DATASET_NOW,
  type MutableReviewedPlanningDataset
} from './reviewed-planning-dataset.test-support';
import { canonicalReviewedDatasetPayload } from './reviewed-planning-dataset-validator';
import {
  CloudBaseReviewedPlanningDataProvider,
  ReviewedDatasetUnavailableError,
  type ReviewedPlanningDatasetSource
} from './cloudbase-reviewed-planning-data-provider';

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label} test fixture`);
  return value;
}

function validDataset(
  mutate?: (candidate: MutableReviewedPlanningDataset) => void
): MutableReviewedPlanningDataset {
  const candidate = createReviewedPlanningDatasetCandidate();
  mutate?.(candidate);
  candidate.checksumSha256 = createHash('sha256')
    .update(canonicalReviewedDatasetPayload(candidate), 'utf8')
    .digest('hex');
  return candidate;
}

function providerWith(source: ReviewedPlanningDatasetSource, clock = {
  iso: REVIEWED_DATASET_NOW,
  ms: 1_000
}) {
  return new CloudBaseReviewedPlanningDataProvider({
    datasetId: 'reviewed-planning-cn-v1',
    source,
    now: () => clock.iso,
    nowMs: () => clock.ms,
    cacheTtlMs: 60_000,
    loadTimeoutMs: 2_000
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CloudBaseReviewedPlanningDataProvider', () => {
  test('shares a cold read, caches within TTL, refreshes after TTL and clones returns', async () => {
    const clock = { iso: REVIEWED_DATASET_NOW, ms: 1_000 };
    const read = vi.fn(() => Promise.resolve(validDataset()));
    const provider = providerWith({ read }, clock);

    const [catalog, snapshot] = await Promise.all([
      provider.getActiveCatalog(),
      provider.getSnapshot('snapshot-oats-v1')
    ]);
    expect(read).toHaveBeenCalledOnce();
    (catalog as unknown as { dailyMenuTemplateVersionIds: string[] })
      .dailyMenuTemplateVersionIds[0] = 'mutated-by-caller';
    (snapshot as unknown as { canonicalNameZh: string }).canonicalNameZh = '被调用者修改';
    expect((await provider.getActiveCatalog()).dailyMenuTemplateVersionIds[0])
      .toBe('menu-day-1-v1');
    expect((await provider.getSnapshot('snapshot-oats-v1')).canonicalNameZh).toBe('燕麦');
    expect(read).toHaveBeenCalledOnce();

    clock.ms += 60_001;
    await provider.getActiveCatalog();
    expect(read).toHaveBeenCalledTimes(2);
  });

  test('times out after 2,000 ms and does not cache a failed candidate', async () => {
    vi.useFakeTimers();
    const read = vi.fn<ReviewedPlanningDatasetSource['read']>()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce(validDataset());
    const provider = providerWith({ read });

    const pending = expect(provider.getActiveCatalog())
      .rejects.toBeInstanceOf(ReviewedDatasetUnavailableError);
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;
    await expect(provider.getActiveCatalog()).resolves.toMatchObject({ id: 'menu-catalog-v1' });
    expect(read).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['missing document', () => null],
    ['database failure', () => Promise.reject(new Error('database sentinel'))],
    ['invalid graph', () => validDataset((candidate) => {
      const menu = required(candidate.dailyMenus[0], 'daily menu');
      required(menu.meals[0], 'daily menu meal').recipeTemplateVersionId = 'missing-recipe';
    })],
    ['checksum mismatch', () => ({ ...validDataset(), checksumSha256: 'f'.repeat(64) })]
  ])('fails closed for %s without caching it', async (_caseName, result) => {
    const read = vi.fn<ReviewedPlanningDatasetSource['read']>()
      .mockImplementationOnce(() => Promise.resolve(result()))
      .mockResolvedValueOnce(validDataset());
    const provider = providerWith({ read });

    await expect(provider.getActiveCatalog()).rejects.toMatchObject({
      code: 'reviewed_dataset_unavailable'
    });
    await expect(provider.getActiveCatalog()).resolves.toMatchObject({ id: 'menu-catalog-v1' });
    expect(read).toHaveBeenCalledTimes(2);
  });

  test('fails when a warm cached dataset crosses its license boundary', async () => {
    const clock = { iso: REVIEWED_DATASET_NOW, ms: 1_000 };
    const dataset = validDataset((candidate) => {
      candidate.validUntil = '2026-09-01T00:00:00.000Z';
      required(candidate.sourceReferences[0], 'source reference').authorizationValidUntil =
        '2026-09-01T00:00:00.000Z';
    });
    const read = vi.fn(() => Promise.resolve(dataset));
    const provider = providerWith({ read }, clock);
    await provider.getActiveCatalog();

    clock.iso = '2026-09-01T00:00:00.000Z';
    clock.ms += 1_000;
    await expect(provider.getActiveCatalog()).rejects.toMatchObject({
      code: 'reviewed_dataset_unavailable'
    });
    expect(read).toHaveBeenCalledOnce();
  });

  test('uses existing food-name normalization and never guesses ambiguity', async () => {
    const unambiguous = providerWith({ read: () => Promise.resolve(validDataset()) });
    await expect(unambiguous.resolveCanonicalName('  燕 麦 ')).resolves.toEqual({
      foodId: 'food-oats',
      canonicalNameZh: '燕麦',
      nutritionSnapshotId: 'snapshot-oats-v1'
    });
    await expect(unambiguous.resolveCanonicalName('不存在')).resolves.toBeNull();

    const ambiguous = providerWith({ read: () => Promise.resolve(validDataset((candidate) => {
      required(candidate.nutritionSnapshots[1], 'second nutrition snapshot').canonicalNameZh = '燕麦';
    })) });
    await expect(ambiguous.resolveCanonicalName('燕麦')).resolves.toBeNull();
  });

  test('returns stable unavailable errors for unknown record IDs', async () => {
    const provider = providerWith({ read: () => Promise.resolve(validDataset()) });
    await expect(provider.getSnapshot('missing')).rejects.toBeInstanceOf(ReviewedDatasetUnavailableError);
    await expect(provider.getByVersionId('missing')).rejects.toMatchObject({
      code: 'reviewed_dataset_unavailable'
    });
    await expect(provider.getMenuByVersionId('missing')).rejects.toMatchObject({
      code: 'reviewed_dataset_unavailable'
    });
  });
});
