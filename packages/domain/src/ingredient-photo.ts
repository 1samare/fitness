export type IngredientPhotoMediaType = 'image/jpeg' | 'image/png';

export interface NormalizedIngredientCandidate {
  readonly id: string;
  readonly foodId: string;
  readonly nutritionSnapshotId: string;
  readonly canonicalNameZh: string;
  readonly confidence: number;
  readonly foodState: 'raw' | 'cooked' | 'dry';
}

export interface IngredientPhotoVersion {
  readonly kind: 'ingredient_photo_version';
  readonly id: string;
  readonly photoId: string;
  readonly userId: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly mediaType: IngredientPhotoMediaType;
  readonly workflowStatus: 'confirmed';
  readonly candidates: readonly NormalizedIngredientCandidate[];
  readonly confirmedCandidateId: string;
  readonly confirmedGrams: number;
  readonly inventoryVersionId: string;
}

export function latestIngredientPhotoVersions(versions: readonly IngredientPhotoVersion[]): readonly IngredientPhotoVersion[] {
  const latestByPhotoId = new Map<string, IngredientPhotoVersion>();
  for (const version of versions) {
    const current = latestByPhotoId.get(version.photoId);
    if (current === undefined || version.revision > current.revision) {
      latestByPhotoId.set(version.photoId, version);
    }
  }
  return [...latestByPhotoId.values()];
}
