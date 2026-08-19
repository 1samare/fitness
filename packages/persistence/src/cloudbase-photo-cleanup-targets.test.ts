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

function state(photos: readonly IngredientPhotoVersion[]): PlanningAggregateState {
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

class FakeQueryDatabase implements CloudBasePhotoCleanupQueryDatabase {
  public readonly filters: unknown[] = [];
  public readonly limits: number[] = [];

  public constructor(private readonly documents: readonly unknown[]) {}

  public readonly command = {
    lte: (value: string) => ({ operator: 'lte', value })
  };

  public collection(name: string) {
    expect(name).toBe('planning_user_states');
    return {
      where: (filter: Readonly<Record<string, unknown>>) => {
        this.filters.push(filter);
        return {
          limit: (limit: number) => {
            this.limits.push(limit);
            return {
              get: () => Promise.resolve({ data: this.documents })
            };
          }
        };
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

  test('rejects due documents that do not carry a server-persisted trusted user identity', async () => {
    const rawState = state([photo('user-a', 'photo-a', before)]);
    const database = new FakeQueryDatabase([{ schemaVersion: 6, state: rawState }]);

    await expect(new CloudBasePhotoCleanupTargetRepository(database).listDueTargets({
      before, limit: 50
    })).rejects.toThrow();
  });
});
