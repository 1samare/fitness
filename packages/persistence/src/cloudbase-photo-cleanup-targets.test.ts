import { describe, expect, test } from 'vitest';
import {
  deriveNextPhotoCleanupAt,
  type IngredientPhotoVersion,
  type PlanningAggregateState
} from '@fitness/domain';
import {
  CloudBasePhotoCleanupTargetRepository,
  type CloudBasePhotoCleanupQueryDatabase
} from './cloudbase-photo-cleanup-targets';

const before = '2026-08-19T23:00:00.000Z';

function photo(
  userId: string,
  photoId: string,
  nextCleanupAt: string,
  overrides: Partial<IngredientPhotoVersion> = {}
): IngredientPhotoVersion {
  const uploadCreatedAt = new Date(
    Date.parse(nextCleanupAt) - 23 * 60 * 60 * 1_000
  ).toISOString();
  return {
    kind: 'ingredient_photo_version',
    id: `${photoId}-version-1`,
    photoId,
    userId,
    revision: 1,
    createdAt: uploadCreatedAt,
    uploadCreatedAt,
    deleteDueAt: nextCleanupAt,
    expectedCloudPath: `ingredient-photos/${photoId}/upload.jpg`,
    expectedPrivateFileId: `cloud://private.bucket/ingredient-photos/${photoId}/upload.jpg`,
    mediaType: 'image/jpeg',
    workflowStatus: 'awaiting_upload',
    storageStatus: 'retained',
    candidates: [],
    confirmedCandidateId: null,
    confirmedGrams: null,
    inventoryVersionId: null,
    recognitionFailureCode: null,
    cleanupAttemptCount: 0,
    nextCleanupAt,
    lastCleanupFailureCode: null,
    deletedAt: null,
    ...overrides
  };
}

function state(
  photos: readonly IngredientPhotoVersion[]
): Omit<PlanningAggregateState, 'assistantConversation'> {
  return {
    bodyProfiles: [], goals: [], trainingPlans: [], dailyEnergyTargets: [],
    dailyNutritionTargets: [], inventories: [], mealPlans: [], mealPlanTargetDiffs: [],
    mealPlanDecisions: [], trainingCompletionEvents: [], recalculationJobs: [],
    ingredientPhotoVersions: photos, outboxEvents: [], idempotencyRecords: [],
    activeBodyProfileVersionId: null, activeGoalVersionId: null,
    activeTrainingPlanVersionId: null, activeInventoryVersionId: null,
    activeMealPlanVersionId: null, nextPhotoCleanupAt: deriveNextPhotoCleanupAt(photos)
  };
}

function stored(userId: string, photos: readonly IngredientPhotoVersion[], id: string) {
  return { _id: id, schemaVersion: 6, state: { ...state(photos), userId } };
}

function sortableString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

class FakeQueryDatabase implements CloudBasePhotoCleanupQueryDatabase {
  public readonly filters: unknown[] = [];
  public readonly limits: number[] = [];
  public readonly skips: number[] = [];
  public readonly orders: Array<readonly [string, 'asc' | 'desc']> = [];

  public constructor(private readonly documents: readonly unknown[]) {}

  public readonly command = {
    lte: (value: string) => ({ operator: 'lte', value })
  };

  public collection(name: string) {
    expect(name).toBe('planning_user_states');
    return {
      where: (filter: Readonly<Record<string, unknown>>) => {
        this.filters.push(filter);
        const makeQuery = (
          orderBy: readonly (readonly [string, 'asc' | 'desc'])[] = [],
          skip = 0,
          limit: number | null = null
        ) => ({
          orderBy: (path: string, direction: 'asc' | 'desc') => {
            this.orders.push([path, direction]);
            return makeQuery([...orderBy, [path, direction]], skip, limit);
          },
          skip: (value: number) => {
            this.skips.push(value);
            return makeQuery(orderBy, value, limit);
          },
          limit: (value: number) => {
            this.limits.push(value);
            return makeQuery(orderBy, skip, value);
          },
          get: () => {
            const condition = filter['state.nextPhotoCleanupAt'] as {
              readonly operator?: unknown;
              readonly value?: unknown;
            };
            const getPath = (document: unknown, path: string): unknown => path.split('.').reduce(
              (current: unknown, segment) => (
                typeof current === 'object' && current !== null && !Array.isArray(current)
                  ? (current as Record<string, unknown>)[segment]
                  : undefined
              ),
              document
            );
            const filtered = this.documents.filter((document) => {
              const pointer = getPath(document, 'state.nextPhotoCleanupAt');
              return condition.operator === 'lte'
                && typeof condition.value === 'string'
                && typeof pointer === 'string'
                && pointer <= condition.value;
            });
            filtered.sort((left, right) => {
              for (const [path, direction] of orderBy) {
                const leftValue = getPath(left, path);
                const rightValue = getPath(right, path);
                const compared = sortableString(leftValue).localeCompare(sortableString(rightValue));
                if (compared !== 0) return direction === 'asc' ? compared : -compared;
              }
              return 0;
            });
            return Promise.resolve({ data: filtered.slice(skip, limit === null ? undefined : skip + limit) });
          }
        });
        return makeQuery();
      }
    };
  }
}

describe('CloudBasePhotoCleanupTargetRepository', () => {
  test('queries the derived due pointer, decodes v6 trusted users, and deterministically sorts latest due photos', async () => {
    const earlier = '2026-08-19T22:00:00.000Z';
    const database = new FakeQueryDatabase([
      stored('user-b', [photo('user-b', 'photo-z', earlier)], 'document-secret-b'),
      stored('user-a', [
        photo('user-a', 'photo-b', before),
        photo('user-a', 'photo-a', earlier)
      ], 'document-secret-a'),
      stored('user-later', [
        photo('user-later', 'photo-later', '2026-08-19T23:00:00.001Z')
      ], 'document-secret-later')
    ]);
    const repository = new CloudBasePhotoCleanupTargetRepository(database);

    const targets = await repository.listDueTargets({ before, limit: 50 });

    expect(database.filters).toEqual([{
      'state.nextPhotoCleanupAt': { operator: 'lte', value: before }
    }]);
    expect(database.limits).toEqual([50]);
    expect(database.orders).toEqual([
      ['state.nextPhotoCleanupAt', 'asc'],
      ['state.userId', 'asc']
    ]);
    expect(targets).toEqual([
      { userId: 'user-a', photoId: 'photo-a' },
      { userId: 'user-b', photoId: 'photo-z' },
      { userId: 'user-a', photoId: 'photo-b' }
    ]);
    expect(JSON.stringify(targets)).not.toContain('document-secret');
  });

  test('uses only each logical photo latest revision and excludes null, deleted, and later targets', async () => {
    const oldDue = photo('user-a', 'photo-a', '2026-08-19T22:00:00.000Z');
    const latestLater = photo('user-a', 'photo-a', '2026-08-20T01:00:00.000Z', {
      id: 'photo-a-version-2', revision: 2, createdAt: '2026-08-19T01:00:00.000Z',
      uploadCreatedAt: oldDue.uploadCreatedAt,
      deleteDueAt: oldDue.deleteDueAt,
      expectedCloudPath: oldDue.expectedCloudPath,
      expectedPrivateFileId: oldDue.expectedPrivateFileId,
      storageStatus: 'cleanup_failed',
      cleanupAttemptCount: 1,
      lastCleanupFailureCode: 'storage_unavailable'
    });
    const deletedFirst = photo('user-a', 'photo-deleted', before, {
      id: 'photo-deleted-version-1'
    });
    const deletedLatest = photo('user-a', 'photo-deleted', before, {
      id: 'photo-deleted-version-2', revision: 2, createdAt: '2026-08-19T01:00:00.000Z',
      storageStatus: 'deleted', nextCleanupAt: null, deletedAt: before
    });
    const database = new FakeQueryDatabase([
      stored('user-a', [oldDue, latestLater, deletedFirst, deletedLatest], 'document-a')
    ]);

    await expect(new CloudBasePhotoCleanupTargetRepository(database).listDueTargets({
      before, limit: 50
    })).resolves.toEqual([]);
  });

  test('caps the target batch at fifty even when a larger limit is requested', async () => {
    const photos = Array.from({ length: 51 }, (_, index) => (
      photo('user-many', `photo-${String(index).padStart(2, '0')}`, before)
    ));
    const database = new FakeQueryDatabase([
      stored('user-many', photos, 'document-many')
    ]);

    const targets = await new CloudBasePhotoCleanupTargetRepository(database).listDueTargets({
      before, limit: 100
    });

    expect(targets).toHaveLength(50);
    expect(database.limits).toEqual([50]);
    expect(targets.at(-1)).toEqual({ userId: 'user-many', photoId: 'photo-49' });
  });

  test('isolates a corrupt due document between valid trusted-user documents', async () => {
    const corruptState = state([photo('untrusted', 'photo-corrupt', before)]);
    const database = new FakeQueryDatabase([
      stored('user-a', [photo('user-a', 'photo-a', before)], 'document-a'),
      { schemaVersion: 6, state: corruptState },
      stored('user-z', [photo('user-z', 'photo-z', before)], 'document-z')
    ]);

    await expect(new CloudBasePhotoCleanupTargetRepository(database).listDueTargets({
      before, limit: 50
    })).resolves.toEqual([
      { userId: 'user-a', photoId: 'photo-a' },
      { userId: 'user-z', photoId: 'photo-z' }
    ]);
  });

  test('orders before a real document limit and overfetches past corrupt rows for the global first fifty', async () => {
    const corrupt = Array.from({ length: 50 }, (_, index) => ({
      schemaVersion: 6,
      state: {
        ...state([photo(
          'untrusted',
          `photo-corrupt-${String(index)}`,
          '2026-08-19T20:00:00.000Z'
        )]),
        userId: ''
      }
    }));
    const valid = Array.from({ length: 51 }, (_, index) => {
      const userId = `user-${String(index).padStart(2, '0')}`;
      return stored(userId, [
        photo(userId, `photo-b-${String(index).padStart(2, '0')}`, before),
        ...(index === 0 ? [photo(userId, 'photo-a', before)] : [])
      ], `document-${String(index)}`);
    });
    const database = new FakeQueryDatabase([...valid.reverse(), ...corrupt]);

    const targets = await new CloudBasePhotoCleanupTargetRepository(database).listDueTargets({
      before,
      limit: 50
    });

    expect(targets).toHaveLength(50);
    expect(targets.slice(0, 3)).toEqual([
      { userId: 'user-00', photoId: 'photo-a' },
      { userId: 'user-00', photoId: 'photo-b-00' },
      { userId: 'user-01', photoId: 'photo-b-01' }
    ]);
    expect(database.limits).toEqual([50, 50, 50]);
    expect(database.skips).toEqual([0, 50, 100]);
  });

  test('bounds one cleanup scan even when every leading due document is corrupt', async () => {
    const corrupt = Array.from({ length: 300 }, (_, index) => ({
      schemaVersion: 6,
      state: {
        ...state([photo(
          'untrusted',
          `photo-corrupt-${String(index)}`,
          '2026-08-19T20:00:00.000Z'
        )]),
        userId: ''
      }
    }));
    const database = new FakeQueryDatabase([
      ...corrupt,
      stored('user-valid', [photo('user-valid', 'photo-valid', before)], 'document-valid')
    ]);

    await expect(new CloudBasePhotoCleanupTargetRepository(database).listDueTargets({
      before,
      limit: 50
    })).resolves.toEqual([]);
    expect(database.limits).toEqual([50, 50, 50, 50, 50]);
    expect(database.skips).toEqual([0, 50, 100, 150, 200]);
  });
});
