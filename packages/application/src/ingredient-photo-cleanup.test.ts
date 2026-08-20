import { describe, expect, test, vi } from 'vitest';
import {
  deriveNextPhotoCleanupAt,
  emptyAssistantConversationState,
  type IngredientPhotoVersion,
  type InventoryVersion,
  type PlanningAggregateState,
  type PrivatePhotoStorage
} from '@fitness/domain';
import { InMemoryPlanningRepository } from '@fitness/persistence';
import { createIngredientPhotoCleanupService } from './ingredient-photo-cleanup';

const uploadCreatedAt = '2026-08-19T00:00:00.000Z';
const dueAt = '2026-08-19T23:00:00.000Z';

function emptyState(): PlanningAggregateState {
  return {
    assistantConversation: emptyAssistantConversationState(),
    bodyProfiles: [],
    goals: [],
    trainingPlans: [],
    dailyEnergyTargets: [],
    dailyNutritionTargets: [],
    inventories: [],
    mealPlans: [],
    mealPlanTargetDiffs: [],
    mealPlanDecisions: [],
    trainingCompletionEvents: [],
    recalculationJobs: [],
    ingredientPhotoVersions: [],
    outboxEvents: [],
    idempotencyRecords: [],
    activeBodyProfileVersionId: null,
    activeGoalVersionId: null,
    activeTrainingPlanVersionId: null,
    activeInventoryVersionId: null,
    activeMealPlanVersionId: null,
    nextPhotoCleanupAt: null
  };
}

function awaitingPhoto(overrides: Partial<IngredientPhotoVersion> = {}): IngredientPhotoVersion {
  return {
    kind: 'ingredient_photo_version',
    id: 'photo-version-1',
    photoId: 'photo-a',
    userId: 'user-a',
    revision: 1,
    createdAt: uploadCreatedAt,
    uploadCreatedAt,
    deleteDueAt: dueAt,
    expectedCloudPath: 'ingredient-photos/photo-a/upload-a.jpg',
    expectedPrivateFileId: 'cloud://private.bucket/ingredient-photos/photo-a/upload-a.jpg',
    mediaType: 'image/jpeg',
    workflowStatus: 'awaiting_upload',
    storageStatus: 'retained',
    candidates: [],
    confirmedCandidateId: null,
    confirmedGrams: null,
    inventoryVersionId: null,
    recognitionFailureCode: null,
    cleanupAttemptCount: 0,
    nextCleanupAt: dueAt,
    lastCleanupFailureCode: null,
    deletedAt: null,
    ...overrides
  };
}

async function seed(
  repository: InMemoryPlanningRepository,
  photos: readonly IngredientPhotoVersion[],
  inventories: readonly InventoryVersion[] = []
): Promise<void> {
  await repository.transact('user-a', () => ({
    nextState: {
      ...emptyState(),
      ingredientPhotoVersions: photos,
      inventories,
      activeInventoryVersionId: inventories.at(-1)?.id ?? null,
      nextPhotoCleanupAt: deriveNextPhotoCleanupAt(photos)
    },
    result: undefined
  }));
}

function createHarness(deleteResult: 'deleted' | 'not_found' = 'deleted') {
  const repository = new InMemoryPlanningRepository();
  let sequence = 1;
  const deletePrivateFile = vi.fn(() => Promise.resolve(deleteResult));
  const storage: PrivatePhotoStorage = {
    inspectPrivateFile: () => Promise.reject(new Error('not used')),
    deletePrivateFile
  };
  const cleanup = createIngredientPhotoCleanupService({
    repository,
    storage,
    nextId: (prefix) => `${prefix}-${String(++sequence)}`
  });
  return { cleanup, deletePrivateFile, repository };
}

function latestPhoto(state: PlanningAggregateState): IngredientPhotoVersion {
  const photo = state.ingredientPhotoVersions.at(-1);
  if (photo === undefined) throw new Error('Expected a photo version');
  return photo;
}

describe('ingredient photo cleanup', () => {
  test('treats an already missing object as successful idempotent deletion', async () => {
    const { cleanup, repository } = createHarness('not_found');
    await seed(repository, [awaitingPhoto()]);

    await expect(cleanup.cleanupDuePhoto('user-a', 'photo-a', dueAt)).resolves.toEqual({
      status: 'deleted'
    });

    const state = await repository.read('user-a');
    expect(latestPhoto(state)).toMatchObject({
      revision: 2,
      storageStatus: 'deleted',
      nextCleanupAt: null,
      deletedAt: dueAt
    });
    expect(state.idempotencyRecords).toEqual([
      expect.objectContaining({
        operation: 'cleanupIngredientPhoto',
        key: `photo-cleanup:photo-a:1:${dueAt}`,
        resultVersionId: latestPhoto(state).id
      })
    ]);
  });

  test('schedules one stable retry without exposing the storage error', async () => {
    const { cleanup, deletePrivateFile, repository } = createHarness();
    deletePrivateFile.mockRejectedValue(
      new Error('cloud://secret raw-provider-error')
    );
    await seed(repository, [awaitingPhoto()]);

    await expect(cleanup.cleanupDuePhoto('user-a', 'photo-a', dueAt)).resolves.toEqual({
      status: 'retry_scheduled',
      retryAt: '2026-08-19T23:15:00.000Z'
    });

    const state = await repository.read('user-a');
    expect(latestPhoto(state)).toMatchObject({
      revision: 2,
      storageStatus: 'cleanup_failed',
      cleanupAttemptCount: 1,
      lastCleanupFailureCode: 'storage_unavailable',
      nextCleanupAt: '2026-08-19T23:15:00.000Z'
    });
    expect(JSON.stringify(state)).not.toContain('raw-provider-error');
    expect(JSON.stringify(state)).not.toContain('cloud://secret');
  });

  test('cleans an unregistered awaiting-upload object at the exact twenty-three-hour boundary', async () => {
    const { cleanup, deletePrivateFile, repository } = createHarness();
    await seed(repository, [awaitingPhoto()]);

    await expect(cleanup.cleanupDuePhoto('user-a', 'photo-a', dueAt)).resolves.toEqual({
      status: 'deleted'
    });
    expect(deletePrivateFile).toHaveBeenCalledWith({
      privateFileId: 'cloud://private.bucket/ingredient-photos/photo-a/upload-a.jpg'
    });
  });

  test('cleans a confirmed photo immediately without changing its inventory link', async () => {
    const { cleanup, repository } = createHarness();
    const candidate = {
      id: 'candidate-a',
      foodId: 'food-a',
      nutritionSnapshotId: 'snapshot-a',
      canonicalNameZh: '西红柿',
      confidence: 0.9,
      foodState: 'raw' as const
    };
    const uploaded = awaitingPhoto({
      id: 'photo-version-2',
      revision: 2,
      createdAt: '2026-08-19T00:01:00.000Z',
      workflowStatus: 'uploaded'
    });
    const recognized = awaitingPhoto({
      ...uploaded,
      id: 'photo-version-3',
      revision: 3,
      createdAt: '2026-08-19T00:01:30.000Z',
      workflowStatus: 'recognized',
      candidates: [candidate]
    });
    const inventory: InventoryVersion = {
      kind: 'inventory_version',
      id: 'inventory-1',
      userId: 'user-a',
      version: 1,
      createdAt: '2026-08-19T00:02:00.000Z',
      items: [{ foodId: 'food-a', nutritionSnapshotId: 'snapshot-a', availableGrams: 125 }]
    };
    const confirmed = awaitingPhoto({
      ...recognized,
      id: 'photo-version-4',
      revision: 4,
      createdAt: inventory.createdAt,
      workflowStatus: 'confirmed',
      storageStatus: 'cleanup_pending',
      confirmedCandidateId: candidate.id,
      confirmedGrams: 125,
      inventoryVersionId: inventory.id,
      nextCleanupAt: inventory.createdAt
    });
    await seed(repository, [awaitingPhoto(), uploaded, recognized, confirmed], [inventory]);

    await expect(cleanup.cleanupDuePhoto(
      'user-a',
      'photo-a',
      inventory.createdAt
    )).resolves.toEqual({ status: 'deleted' });
    expect(latestPhoto(await repository.read('user-a'))).toMatchObject({
      workflowStatus: 'confirmed',
      inventoryVersionId: 'inventory-1',
      storageStatus: 'deleted'
    });
  });

  test('does not touch storage before a cleanup target is due', async () => {
    const { cleanup, deletePrivateFile, repository } = createHarness();
    await seed(repository, [awaitingPhoto()]);

    await expect(cleanup.cleanupDuePhoto(
      'user-a',
      'photo-a',
      '2026-08-19T22:59:59.999Z'
    )).resolves.toEqual({ status: 'skipped' });
    expect(deletePrivateFile).not.toHaveBeenCalled();
    expect((await repository.read('user-a')).ingredientPhotoVersions).toHaveLength(1);
  });

  test('replay after a deleted revision is a no-op without a second storage call', async () => {
    const { cleanup, deletePrivateFile, repository } = createHarness();
    await seed(repository, [awaitingPhoto()]);
    await cleanup.cleanupDuePhoto('user-a', 'photo-a', dueAt);

    await expect(cleanup.cleanupDuePhoto('user-a', 'photo-a', dueAt)).resolves.toEqual({
      status: 'skipped'
    });
    expect(deletePrivateFile).toHaveBeenCalledTimes(1);
    expect((await repository.read('user-a')).ingredientPhotoVersions).toHaveLength(2);
  });

  test('does not append against a concurrent revision and finishes on the next idempotent missing-object pass', async () => {
    const repository = new InMemoryPlanningRepository();
    let releaseDeletion: ((value: 'deleted') => void) | undefined;
    const firstDeletion = new Promise<'deleted'>((resolve) => {
      releaseDeletion = resolve;
    });
    const deletePrivateFile = vi.fn()
      .mockImplementationOnce(() => firstDeletion)
      .mockResolvedValueOnce('not_found');
    const storage: PrivatePhotoStorage = {
      inspectPrivateFile: () => Promise.reject(new Error('not used')),
      deletePrivateFile
    };
    let sequence = 10;
    const cleanup = createIngredientPhotoCleanupService({
      repository,
      storage,
      nextId: (prefix) => `${prefix}-${String(++sequence)}`
    });
    await seed(repository, [awaitingPhoto()]);

    const inFlight = cleanup.cleanupDuePhoto('user-a', 'photo-a', dueAt);
    await vi.waitFor(() => {
      expect(deletePrivateFile).toHaveBeenCalledTimes(1);
    });
    const concurrent = awaitingPhoto({
      id: 'photo-version-concurrent',
      revision: 2,
      createdAt: '2026-08-19T22:59:00.000Z'
    });
    await repository.transact('user-a', (state) => ({
      nextState: {
        ...state,
        ingredientPhotoVersions: [...state.ingredientPhotoVersions, concurrent]
      },
      result: undefined
    }));
    if (releaseDeletion !== undefined) releaseDeletion('deleted');

    await expect(inFlight).resolves.toEqual({ status: 'skipped' });
    expect(latestPhoto(await repository.read('user-a')).id).toBe(concurrent.id);
    await expect(cleanup.cleanupDuePhoto('user-a', 'photo-a', dueAt)).resolves.toEqual({
      status: 'deleted'
    });
    expect(deletePrivateFile).toHaveBeenCalledTimes(2);
  });
});
