import {
  deriveNextPhotoCleanupAt,
  latestIngredientPhotoVersions,
  type IdempotencyRecord,
  type IngredientPhotoVersion,
  type PlanningAggregateState,
  type PrivatePhotoStorage
} from '@fitness/domain';
import { requestFingerprint } from './idempotency-fingerprint';
import type { PlanningRepository } from './versioned-planning';

const RETRY_DELAY_MS = 15 * 60 * 1_000;

export interface PhotoCleanupTargetRepository {
  listDueTargets(input: {
    readonly before: string;
    readonly limit: number;
  }): Promise<readonly { readonly userId: string; readonly photoId: string }[]>;
}

export type IngredientPhotoCleanupResult =
  | { readonly status: 'deleted' }
  | { readonly status: 'retry_scheduled'; readonly retryAt: string }
  | { readonly status: 'skipped' };

export interface IngredientPhotoCleanupService {
  cleanupDuePhoto(
    userId: string,
    photoId: string,
    nowIso: string
  ): Promise<IngredientPhotoCleanupResult>;
}

export interface IngredientPhotoCleanupDependencies {
  readonly repository: PlanningRepository;
  readonly storage: PrivatePhotoStorage;
  readonly nextId: (prefix: string) => string;
}

function latestPhoto(
  state: PlanningAggregateState,
  photoId: string
): IngredientPhotoVersion | undefined {
  return latestIngredientPhotoVersions(state.ingredientPhotoVersions)
    .find((photo) => photo.photoId === photoId);
}

function isDue(photo: IngredientPhotoVersion, nowIso: string): boolean {
  return photo.storageStatus !== 'deleted'
    && photo.nextCleanupAt !== null
    && photo.nextCleanupAt <= nowIso;
}

function sameStorageIdentity(left: IngredientPhotoVersion, right: IngredientPhotoVersion): boolean {
  return left.photoId === right.photoId
    && left.uploadCreatedAt === right.uploadCreatedAt
    && left.expectedCloudPath === right.expectedCloudPath
    && left.expectedPrivateFileId === right.expectedPrivateFileId
    && left.mediaType === right.mediaType;
}

function addRetryDelay(nowIso: string): string {
  const timestamp = Date.parse(nowIso);
  if (!Number.isFinite(timestamp)) throw new TypeError('Cleanup clock must be an ISO timestamp');
  return new Date(timestamp + RETRY_DELAY_MS).toISOString();
}

function replayResult(
  state: PlanningAggregateState,
  record: Extract<IdempotencyRecord, { readonly operation: 'cleanupIngredientPhoto' }>
): IngredientPhotoCleanupResult {
  const photo = state.ingredientPhotoVersions.find((value) => value.id === record.resultVersionId);
  if (photo?.storageStatus === 'deleted') return { status: 'deleted' };
  if (photo?.storageStatus === 'cleanup_failed' && photo.nextCleanupAt !== null) {
    return { status: 'retry_scheduled', retryAt: photo.nextCleanupAt };
  }
  return { status: 'skipped' };
}

export function createIngredientPhotoCleanupService(
  dependencies: IngredientPhotoCleanupDependencies
): IngredientPhotoCleanupService {
  return {
    async cleanupDuePhoto(userId, photoId, nowIso) {
      const initialState = await dependencies.repository.read(userId);
      const source = latestPhoto(initialState, photoId);
      if (source === undefined || !isDue(source, nowIso)) return { status: 'skipped' };
      const nextCleanupAt = source.nextCleanupAt;
      if (nextCleanupAt === null) return { status: 'skipped' };
      const command = {
        expectedVersion: source.revision,
        idempotencyKey: `photo-cleanup:${photoId}:${String(source.revision)}:${nextCleanupAt}`,
        payload: { photoId, nextCleanupAt }
      } as const;
      const expectedFingerprint = requestFingerprint({
        expectedVersion: command.expectedVersion,
        payload: command.payload
      });

      let deletionSucceeded = false;
      try {
        await dependencies.storage.deletePrivateFile({
          privateFileId: source.expectedPrivateFileId
        });
        deletionSucceeded = true;
      } catch {
        deletionSucceeded = false;
      }

      return dependencies.repository.transact(userId, (state) => {
        const replay = state.idempotencyRecords.find((record): record is Extract<
          IdempotencyRecord,
          { readonly operation: 'cleanupIngredientPhoto' }
        > => record.operation === 'cleanupIngredientPhoto' && record.key === command.idempotencyKey);
        if (replay !== undefined) {
          return { nextState: state, result: replayResult(state, replay) };
        }
        const current = latestPhoto(state, photoId);
        if (
          current === undefined
          || current.revision !== command.expectedVersion
          || !sameStorageIdentity(source, current)
          || current.nextCleanupAt !== command.payload.nextCleanupAt
          || !isDue(current, nowIso)
        ) return { nextState: state, result: { status: 'skipped' as const } };

        const retryAt = addRetryDelay(nowIso);
        const photo: IngredientPhotoVersion = deletionSucceeded
          ? {
              ...current,
              id: dependencies.nextId('ingredient-photo-version'),
              revision: current.revision + 1,
              createdAt: nowIso,
              storageStatus: 'deleted',
              nextCleanupAt: null,
              lastCleanupFailureCode: null,
              deletedAt: nowIso
            }
          : {
              ...current,
              id: dependencies.nextId('ingredient-photo-version'),
              revision: current.revision + 1,
              createdAt: nowIso,
              storageStatus: 'cleanup_failed',
              cleanupAttemptCount: current.cleanupAttemptCount + 1,
              nextCleanupAt: retryAt,
              lastCleanupFailureCode: 'storage_unavailable',
              deletedAt: null
            };
        const record: IdempotencyRecord = {
          operation: 'cleanupIngredientPhoto',
          key: command.idempotencyKey,
          requestFingerprint: expectedFingerprint,
          resultVersionId: photo.id
        };
        const ingredientPhotoVersions = [...state.ingredientPhotoVersions, photo];
        return {
          nextState: {
            ...state,
            ingredientPhotoVersions,
            idempotencyRecords: [...state.idempotencyRecords, record],
            nextPhotoCleanupAt: deriveNextPhotoCleanupAt(ingredientPhotoVersions)
          },
          result: deletionSucceeded
            ? { status: 'deleted' as const }
            : { status: 'retry_scheduled' as const, retryAt }
        };
      });
    }
  };
}
