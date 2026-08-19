export type IngredientPhotoMediaType = 'image/jpeg' | 'image/png';
export type IngredientPhotoWorkflowStatus = 'awaiting_upload' | 'uploaded' | 'recognized' | 'recognition_failed' | 'confirmed';
export type IngredientPhotoStorageStatus = 'retained' | 'cleanup_pending' | 'cleanup_failed' | 'deleted';
export type PhotoCleanupFailureCode = 'storage_unavailable';

export interface VisionCandidate {
  readonly providerCandidateId: string;
  readonly name: string;
  readonly confidence: number;
  readonly foodState: 'raw' | 'cooked' | 'dry' | 'unknown';
}

export interface VisionProvider {
  recognize(input: { readonly privateFileId: string; readonly requestId: string }): Promise<{
    readonly providerRequestId: string;
    readonly candidates: readonly VisionCandidate[];
  }>;
}

export interface PrivatePhotoStorage {
  inspectPrivateFile(input: { readonly privateFileId: string }): Promise<{
    readonly mediaType: IngredientPhotoMediaType;
    readonly sizeBytes: number;
  }>;
  deletePrivateFile(input: { readonly privateFileId: string }): Promise<'deleted' | 'not_found'>;
}

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
  readonly uploadCreatedAt: string;
  readonly deleteDueAt: string;
  readonly expectedCloudPath: string;
  readonly expectedPrivateFileId: string;
  readonly mediaType: IngredientPhotoMediaType;
  readonly workflowStatus: IngredientPhotoWorkflowStatus;
  readonly storageStatus: IngredientPhotoStorageStatus;
  readonly candidates: readonly NormalizedIngredientCandidate[];
  readonly confirmedCandidateId: string | null;
  readonly confirmedGrams: number | null;
  readonly inventoryVersionId: string | null;
  readonly recognitionFailureCode: 'no_supported_candidate' | null;
  readonly cleanupAttemptCount: number;
  readonly nextCleanupAt: string | null;
  readonly lastCleanupFailureCode: PhotoCleanupFailureCode | null;
  readonly deletedAt: string | null;
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

export function deriveNextPhotoCleanupAt(versions: readonly IngredientPhotoVersion[]): string | null {
  let nextCleanupAt: string | null = null;
  for (const version of latestIngredientPhotoVersions(versions)) {
    if (version.storageStatus === 'deleted' || version.nextCleanupAt === null) continue;
    if (nextCleanupAt === null || version.nextCleanupAt < nextCleanupAt) {
      nextCleanupAt = version.nextCleanupAt;
    }
  }
  return nextCleanupAt;
}
