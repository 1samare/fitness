import { describe, expect, test } from 'vitest';
import type { IngredientPhotoVersion } from './ingredient-photo';
import { latestIngredientPhotoVersions } from './ingredient-photo';

function photo(input: {
  readonly id: string;
  readonly photoId?: string;
  readonly revision: number;
}): IngredientPhotoVersion {
  return {
    kind: 'ingredient_photo_version',
    id: input.id,
    photoId: input.photoId ?? 'photo-a',
    userId: 'local-default',
    revision: input.revision,
    createdAt: '2026-08-26T00:00:00.000Z',
    mediaType: 'image/jpeg',
    workflowStatus: 'confirmed',
    candidates: [{
      id: 'candidate-a',
      foodId: 'fixture-rice',
      nutritionSnapshotId: 'snapshot-fixture-rice-v1',
      canonicalNameZh: '测试米饭',
      confidence: 0.97,
      foodState: 'cooked'
    }],
    confirmedCandidateId: 'candidate-a',
    confirmedGrams: 180,
    inventoryVersionId: 'inventory-a'
  };
}

describe('local ingredient candidate confirmation versions', () => {
  test('keeps only the latest revision for each logical photo', () => {
    const latest = latestIngredientPhotoVersions([
      photo({ id: 'a-v1', revision: 1 }),
      photo({ id: 'b-v1', photoId: 'photo-b', revision: 1 }),
      photo({ id: 'a-v2', revision: 2 })
    ]);

    expect(latest.map((version) => version.id).sort()).toEqual(['a-v2', 'b-v1']);
  });
});
