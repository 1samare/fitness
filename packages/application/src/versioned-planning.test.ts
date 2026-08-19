import { describe, expect, test } from 'vitest';
import type { IngredientPhotoVersion } from '@fitness/domain';
import { deriveNextPhotoCleanupAt } from '@fitness/domain';
import { InMemoryPlanningRepository } from '@fitness/persistence';
import { createVersionedPlanningService } from './versioned-planning';

function photo(input: {
  readonly id: string;
  readonly photoId: string;
  readonly revision: number;
  readonly uploadCreatedAt: string;
  readonly workflowStatus?: IngredientPhotoVersion['workflowStatus'];
  readonly storageStatus?: IngredientPhotoVersion['storageStatus'];
  readonly candidates?: IngredientPhotoVersion['candidates'];
}): IngredientPhotoVersion {
  const uploadTime = Date.parse(input.uploadCreatedAt);
  const deleteDueAt = new Date(uploadTime + 23 * 60 * 60 * 1_000).toISOString();
  const deleted = input.storageStatus === 'deleted';
  return {
    kind: 'ingredient_photo_version',
    id: input.id,
    photoId: input.photoId,
    userId: 'user-a',
    revision: input.revision,
    createdAt: input.uploadCreatedAt,
    uploadCreatedAt: input.uploadCreatedAt,
    deleteDueAt,
    expectedCloudPath: `ingredient-photos/${input.photoId}/upload.jpg`,
    expectedPrivateFileId: `cloud://env.bucket/ingredient-photos/${input.photoId}/upload.jpg`,
    mediaType: 'image/jpeg',
    workflowStatus: input.workflowStatus ?? 'awaiting_upload',
    storageStatus: input.storageStatus ?? 'retained',
    candidates: input.candidates ?? [],
    confirmedCandidateId: null,
    confirmedGrams: null,
    inventoryVersionId: null,
    recognitionFailureCode: null,
    cleanupAttemptCount: 0,
    nextCleanupAt: deleted ? null : deleteDueAt,
    lastCleanupFailureCode: null,
    deletedAt: deleted ? '2026-08-19T02:00:00.000Z' : null
  };
}

describe('versioned planning ingredient photo context', () => {
  test('returns the most recently created logical photo after original storage deletion', async () => {
    const repository = new InMemoryPlanningRepository();
    const service = createVersionedPlanningService({
      repository,
      now: () => '2026-08-19T00:00:00.000Z',
      nextId: (prefix) => `${prefix}-unused`
    });
    const first = photo({
      id: 'photo-a-version-1',
      photoId: 'photo-a',
      revision: 1,
      uploadCreatedAt: '2026-08-19T00:00:00.000Z'
    });
    const secondAwaiting = photo({
      id: 'photo-b-version-1',
      photoId: 'photo-b',
      revision: 1,
      uploadCreatedAt: '2026-08-19T01:00:00.000Z'
    });
    const secondUploaded = {
      ...secondAwaiting,
      id: 'photo-b-version-2',
      revision: 2,
      workflowStatus: 'uploaded' as const
    };
    const candidates = [{
      id: 'candidate-b',
      foodId: 'food-b',
      nutritionSnapshotId: 'snapshot-b',
      canonicalNameZh: '食材B',
      confidence: 0.9,
      foodState: 'raw' as const
    }];
    const secondRecognized = {
      ...secondUploaded,
      id: 'photo-b-version-3',
      revision: 3,
      workflowStatus: 'recognized' as const,
      candidates
    };
    const secondDeleted = {
      ...secondRecognized,
      id: 'photo-b-version-4',
      revision: 4,
      storageStatus: 'deleted' as const,
      nextCleanupAt: null,
      deletedAt: '2026-08-19T02:00:00.000Z'
    };
    const versions = [secondAwaiting, secondUploaded, secondRecognized, secondDeleted, first];
    await repository.transact('user-a', (state) => ({
      nextState: {
        ...state,
        ingredientPhotoVersions: versions,
        nextPhotoCleanupAt: deriveNextPhotoCleanupAt(versions)
      },
      result: undefined
    }));

    const context = await service.getCurrentContext('user-a');

    expect(context.ingredientPhoto).toMatchObject({
      photoId: 'photo-b',
      revision: 4,
      workflowStatus: 'recognized',
      storageStatus: 'deleted',
      candidates
    });
    expect(context.latestVersions.ingredientPhoto).toBe(2);
  });

  test('breaks equal upload timestamps by logical photo ID independent of stored order', async () => {
    const repository = new InMemoryPlanningRepository();
    const service = createVersionedPlanningService({
      repository,
      now: () => '2026-08-19T00:00:00.000Z',
      nextId: (prefix) => `${prefix}-unused`
    });
    const photoB = photo({
      id: 'photo-b-version-1',
      photoId: 'photo-b',
      revision: 1,
      uploadCreatedAt: '2026-08-19T00:00:00.000Z'
    });
    const photoA = photo({
      id: 'photo-a-version-1',
      photoId: 'photo-a',
      revision: 1,
      uploadCreatedAt: '2026-08-19T00:00:00.000Z'
    });
    const versions = [photoB, photoA];
    await repository.transact('user-a', (state) => ({
      nextState: {
        ...state,
        ingredientPhotoVersions: versions,
        nextPhotoCleanupAt: deriveNextPhotoCleanupAt(versions)
      },
      result: undefined
    }));

    const context = await service.getCurrentContext('user-a');

    expect(context.ingredientPhoto?.photoId).toBe('photo-b');
    expect(context.latestVersions.ingredientPhoto).toBe(2);
  });
});
