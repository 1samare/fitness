import { describe, expect, test } from 'vitest';
import type { IngredientPhotoVersion } from './ingredient-photo';
import { deriveNextPhotoCleanupAt, latestIngredientPhotoVersions } from './ingredient-photo';

function photo(input: Partial<IngredientPhotoVersion> & Pick<IngredientPhotoVersion, 'id' | 'revision'>): IngredientPhotoVersion {
  return {
    kind: 'ingredient_photo_version',
    id: input.id,
    photoId: input.photoId ?? 'photo-a',
    userId: 'user-a',
    revision: input.revision,
    createdAt: '2026-08-19T00:00:00.000Z',
    uploadCreatedAt: '2026-08-19T00:00:00.000Z',
    deleteDueAt: '2026-08-19T23:00:00.000Z',
    expectedCloudPath: 'ingredient-photos/photo-a/upload-a.jpg',
    expectedPrivateFileId: 'cloud://env.bucket/ingredient-photos/photo-a/upload-a.jpg',
    mediaType: 'image/jpeg',
    workflowStatus: 'awaiting_upload',
    storageStatus: input.storageStatus ?? 'retained',
    candidates: [],
    confirmedCandidateId: null,
    confirmedGrams: null,
    inventoryVersionId: null,
    recognitionFailureCode: null,
    cleanupAttemptCount: 0,
    nextCleanupAt: input.nextCleanupAt ?? '2026-08-19T23:00:00.000Z',
    lastCleanupFailureCode: null,
    deletedAt: null
  };
}

describe('ingredient photo derived state', () => {
  test('keeps only the latest revision for each logical photo', () => {
    expect(latestIngredientPhotoVersions([
      photo({ id: 'v1', revision: 1 }),
      photo({ id: 'v2', revision: 2 }),
      photo({ id: 'b1', photoId: 'photo-b', revision: 1 })
    ]).map((value) => value.id)).toEqual(['v2', 'b1']);
  });

  test('derives the earliest outstanding cleanup time and ignores deleted storage', () => {
    expect(deriveNextPhotoCleanupAt([
      photo({ id: 'a', revision: 1, nextCleanupAt: '2026-08-19T23:15:00.000Z' }),
      photo({ id: 'b', photoId: 'photo-b', revision: 1, nextCleanupAt: '2026-08-19T23:00:00.000Z' }),
      photo({ id: 'c', photoId: 'photo-c', revision: 1, storageStatus: 'deleted', nextCleanupAt: null })
    ])).toBe('2026-08-19T23:00:00.000Z');
  });
});
