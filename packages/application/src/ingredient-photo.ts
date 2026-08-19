import { nutritionDataSnapshotSchema } from '@fitness/contracts';
import {
  deriveNextPhotoCleanupAt,
  latestIngredientPhotoVersions,
  type IdempotencyRecord,
  type IngredientPhotoMediaType,
  type IngredientPhotoVersion,
  type NormalizedIngredientCandidate,
  type NutritionProvider,
  type PlanningAggregateState,
  type PrivatePhotoStorage,
  type VisionCandidate,
  type VisionProvider,
  type WriteCommandEnvelope
} from '@fitness/domain';
import { requestFingerprint } from './idempotency-fingerprint';
import { ProviderUnavailableError } from './meal-plan-generation';
import {
  createMealPlanRecalculationService,
  type MealPlanRecalculationServiceDependencies
} from './meal-plan-recalculation';
import {
  IdempotencyKeyReuseError,
  VersionConflictError,
  type PlanningRepository
} from './versioned-planning';

const MAXIMUM_PRIVATE_PHOTO_BYTES = 10 * 1024 * 1024;

export interface IngredientPhotoCommandDependencies {
  readonly repository: PlanningRepository;
  readonly nutrition: NutritionProvider;
  readonly vision: VisionProvider;
  readonly storage: PrivatePhotoStorage;
  readonly now: () => string;
  readonly nextId: (prefix: string) => string;
  readonly storageFileIdPrefix: string;
  readonly allowTestFixtures: boolean;
}

export class IngredientPhotoNotFoundError extends Error {
  public readonly code = 'ingredient_photo_not_found' as const;

  public constructor() {
    super('Ingredient photo was not found');
    this.name = 'IngredientPhotoNotFoundError';
  }
}

export class PrivatePhotoOwnershipError extends Error {
  public readonly code = 'private_photo_ownership_mismatch' as const;

  public constructor() {
    super('Private photo does not match the upload session');
    this.name = 'PrivatePhotoOwnershipError';
  }
}

export class StorageUnavailableError extends Error {
  public readonly code = 'storage_unavailable' as const;

  public constructor() {
    super('Private photo storage is unavailable');
    this.name = 'StorageUnavailableError';
  }
}

export interface CreatedIngredientPhotoUpload {
  readonly cloudPath: string;
  readonly photo: IngredientPhotoVersion;
}

export interface IngredientPhotoCommandResult {
  readonly photo: IngredientPhotoVersion;
}

type IngredientPhotoOperation =
  | 'createIngredientPhotoUpload'
  | 'registerIngredientPhotoUpload'
  | 'recognizeIngredientPhoto';

function normalizeStoragePrefix(value: string): string {
  if (!/^cloud:\/\/[^/]+/.test(value)) throw new PrivatePhotoOwnershipError();
  return `${value.replace(/\/+$/, '')}/`;
}

function mediaExtension(mediaType: IngredientPhotoMediaType): 'jpg' | 'png' {
  if (mediaType === 'image/jpeg') return 'jpg';
  if (mediaType === 'image/png') return 'png';
  throw new PrivatePhotoOwnershipError();
}

function addHours(value: string, hours: number): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError('Clock must return an ISO timestamp');
  return new Date(timestamp + hours * 60 * 60 * 1_000).toISOString();
}

function commandFingerprint<TPayload>(envelope: WriteCommandEnvelope<TPayload>): string {
  return requestFingerprint({
    expectedVersion: envelope.expectedVersion,
    payload: envelope.payload
  });
}

function findRecord<TOperation extends IngredientPhotoOperation>(
  state: PlanningAggregateState,
  operation: TOperation,
  key: string
): Extract<IdempotencyRecord, { readonly operation: TOperation }> | undefined {
  return state.idempotencyRecords.find(
    (record): record is Extract<IdempotencyRecord, { readonly operation: TOperation }> => (
      record.operation === operation && record.key === key
    )
  );
}

function assertReplay(
  record: IdempotencyRecord,
  expectedFingerprint: string,
  idempotencyKey: string
): void {
  if (record.requestFingerprint !== expectedFingerprint) {
    throw new IdempotencyKeyReuseError(idempotencyKey);
  }
}

function resultPhoto(
  state: PlanningAggregateState,
  resultVersionId: string
): IngredientPhotoVersion {
  const result = state.ingredientPhotoVersions.find((photo) => photo.id === resultVersionId);
  if (result === undefined) throw new Error('Stored idempotency result is missing');
  return result;
}

function latestPhoto(
  state: PlanningAggregateState,
  photoId: string
): IngredientPhotoVersion {
  const result = latestIngredientPhotoVersions(state.ingredientPhotoVersions)
    .find((photo) => photo.photoId === photoId);
  if (result === undefined) throw new IngredientPhotoNotFoundError();
  return result;
}

function assertExpectedRevision(expectedVersion: number, photo: IngredientPhotoVersion): void {
  if (expectedVersion !== photo.revision) {
    throw new VersionConflictError(expectedVersion, photo.revision);
  }
}

function assertSameStorageIdentity(
  beforeIo: IngredientPhotoVersion,
  current: IngredientPhotoVersion
): void {
  if (
    current.photoId !== beforeIo.photoId
    || current.uploadCreatedAt !== beforeIo.uploadCreatedAt
    || current.expectedCloudPath !== beforeIo.expectedCloudPath
    || current.expectedPrivateFileId !== beforeIo.expectedPrivateFileId
    || current.mediaType !== beforeIo.mediaType
  ) {
    throw new PrivatePhotoOwnershipError();
  }
}

function stateWithPhotoVersion(
  state: PlanningAggregateState,
  photo: IngredientPhotoVersion,
  record: IdempotencyRecord
): PlanningAggregateState {
  const ingredientPhotoVersions = [...state.ingredientPhotoVersions, photo];
  return {
    ...state,
    ingredientPhotoVersions,
    idempotencyRecords: [...state.idempotencyRecords, record],
    nextPhotoCleanupAt: deriveNextPhotoCleanupAt(ingredientPhotoVersions)
  };
}

function stableCandidateId(
  photoId: string,
  foodId: string,
  nutritionSnapshotId: string,
  foodState: NormalizedIngredientCandidate['foodState']
): string {
  const fingerprint = requestFingerprint({ photoId, foodId, nutritionSnapshotId, foodState });
  return `ingredient-candidate-${fingerprint.slice('v2:sha256:'.length)}`;
}

function candidateIdentity(candidate: NormalizedIngredientCandidate): string {
  return `${candidate.foodId}\u0000${candidate.nutritionSnapshotId}\u0000${candidate.foodState}`;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

async function normalizeCandidate(
  dependencies: IngredientPhotoCommandDependencies,
  photoId: string,
  raw: VisionCandidate
): Promise<NormalizedIngredientCandidate | null> {
  if (raw.foodState === 'unknown') return null;
  let resolution;
  try {
    resolution = await dependencies.nutrition.resolveCanonicalName(raw.name);
  } catch {
    throw new ProviderUnavailableError('nutrition_source_unavailable');
  }
  if (resolution === null) return null;
  let rawSnapshot;
  try {
    rawSnapshot = await dependencies.nutrition.getSnapshot(resolution.nutritionSnapshotId);
  } catch {
    throw new ProviderUnavailableError('nutrition_source_unavailable');
  }
  const parsedSnapshot = nutritionDataSnapshotSchema.safeParse(rawSnapshot);
  if (!parsedSnapshot.success) return null;
  const snapshot = parsedSnapshot.data;
  if (
    snapshot.id !== resolution.nutritionSnapshotId
    || snapshot.foodId !== resolution.foodId
    || snapshot.foodState !== raw.foodState
    || (
      snapshot.qualityStatus !== 'reviewed'
      && !(dependencies.allowTestFixtures && snapshot.qualityStatus === 'test_fixture')
    )
  ) return null;
  return {
    id: stableCandidateId(
      photoId,
      resolution.foodId,
      resolution.nutritionSnapshotId,
      raw.foodState
    ),
    foodId: resolution.foodId,
    nutritionSnapshotId: resolution.nutritionSnapshotId,
    canonicalNameZh: resolution.canonicalNameZh,
    confidence: raw.confidence,
    foodState: raw.foodState
  };
}

async function normalizeCandidates(
  dependencies: IngredientPhotoCommandDependencies,
  photoId: string,
  candidates: readonly VisionCandidate[]
): Promise<readonly NormalizedIngredientCandidate[]> {
  const byIdentity = new Map<string, NormalizedIngredientCandidate>();
  for (const raw of candidates) {
    const normalized = await normalizeCandidate(dependencies, photoId, raw);
    if (normalized === null) continue;
    const identity = candidateIdentity(normalized);
    const current = byIdentity.get(identity);
    if (current === undefined || normalized.confidence > current.confidence) {
      byIdentity.set(identity, normalized);
    }
  }
  return [...byIdentity.values()]
    .sort((left, right) => (
      right.confidence - left.confidence
      || compareCodeUnits(candidateIdentity(left), candidateIdentity(right))
    ))
    .slice(0, 5);
}

export function createIngredientPhotoCommands(
  dependencies: IngredientPhotoCommandDependencies
) {
  const storageFileIdPrefix = normalizeStoragePrefix(dependencies.storageFileIdPrefix);
  const { repository } = dependencies;

  return {
    async createIngredientPhotoUpload(
      userId: string,
      envelope: WriteCommandEnvelope<{ readonly mediaType: IngredientPhotoMediaType }>
    ): Promise<CreatedIngredientPhotoUpload> {
      const expectedFingerprint = commandFingerprint(envelope);
      return repository.transact(userId, (state) => {
        const replay = findRecord(
          state,
          'createIngredientPhotoUpload',
          envelope.idempotencyKey
        );
        if (replay !== undefined) {
          assertReplay(replay, expectedFingerprint, envelope.idempotencyKey);
          const photo = resultPhoto(state, replay.resultVersionId);
          return {
            nextState: state,
            result: { cloudPath: photo.expectedCloudPath, photo }
          };
        }
        const logicalPhotoCount = latestIngredientPhotoVersions(
          state.ingredientPhotoVersions
        ).length;
        if (envelope.expectedVersion !== logicalPhotoCount) {
          throw new VersionConflictError(envelope.expectedVersion, logicalPhotoCount);
        }
        const extension = mediaExtension(envelope.payload.mediaType);
        const photoId = dependencies.nextId('ingredient-photo');
        const uploadId = dependencies.nextId('ingredient-photo-upload');
        const versionId = dependencies.nextId('ingredient-photo-version');
        const createdAt = dependencies.now();
        const deleteDueAt = addHours(createdAt, 23);
        const cloudPath = `ingredient-photos/${photoId}/${uploadId}.${extension}`;
        const photo: IngredientPhotoVersion = {
          kind: 'ingredient_photo_version',
          id: versionId,
          photoId,
          userId,
          revision: 1,
          createdAt,
          uploadCreatedAt: createdAt,
          deleteDueAt,
          expectedCloudPath: cloudPath,
          expectedPrivateFileId: `${storageFileIdPrefix}${cloudPath}`,
          mediaType: envelope.payload.mediaType,
          workflowStatus: 'awaiting_upload',
          storageStatus: 'retained',
          candidates: [],
          confirmedCandidateId: null,
          confirmedGrams: null,
          inventoryVersionId: null,
          recognitionFailureCode: null,
          cleanupAttemptCount: 0,
          nextCleanupAt: deleteDueAt,
          lastCleanupFailureCode: null,
          deletedAt: null
        };
        const record: IdempotencyRecord = {
          operation: 'createIngredientPhotoUpload',
          key: envelope.idempotencyKey,
          requestFingerprint: expectedFingerprint,
          resultVersionId: photo.id
        };
        return {
          nextState: stateWithPhotoVersion(state, photo, record),
          result: { cloudPath, photo }
        };
      });
    },

    async registerIngredientPhotoUpload(
      userId: string,
      envelope: WriteCommandEnvelope<{
        readonly photoId: string;
        readonly privateFileId: string;
      }>
    ): Promise<IngredientPhotoCommandResult> {
      const expectedFingerprint = commandFingerprint(envelope);
      const initialState = await repository.read(userId);
      const initialReplay = findRecord(
        initialState,
        'registerIngredientPhotoUpload',
        envelope.idempotencyKey
      );
      if (initialReplay !== undefined) {
        assertReplay(initialReplay, expectedFingerprint, envelope.idempotencyKey);
        return { photo: resultPhoto(initialState, initialReplay.resultVersionId) };
      }
      const beforeIo = latestPhoto(initialState, envelope.payload.photoId);
      assertExpectedRevision(envelope.expectedVersion, beforeIo);
      if (
        beforeIo.workflowStatus !== 'awaiting_upload'
        || envelope.payload.privateFileId !== beforeIo.expectedPrivateFileId
      ) throw new PrivatePhotoOwnershipError();

      let inspected;
      try {
        inspected = await dependencies.storage.inspectPrivateFile({
          privateFileId: beforeIo.expectedPrivateFileId
        });
      } catch {
        throw new StorageUnavailableError();
      }
      if (
        inspected.mediaType !== beforeIo.mediaType
        || !Number.isInteger(inspected.sizeBytes)
        || inspected.sizeBytes <= 0
        || inspected.sizeBytes > MAXIMUM_PRIVATE_PHOTO_BYTES
      ) throw new PrivatePhotoOwnershipError();

      return repository.transact(userId, (state) => {
        const replay = findRecord(
          state,
          'registerIngredientPhotoUpload',
          envelope.idempotencyKey
        );
        if (replay !== undefined) {
          assertReplay(replay, expectedFingerprint, envelope.idempotencyKey);
          return {
            nextState: state,
            result: { photo: resultPhoto(state, replay.resultVersionId) }
          };
        }
        const current = latestPhoto(state, envelope.payload.photoId);
        assertExpectedRevision(envelope.expectedVersion, current);
        assertSameStorageIdentity(beforeIo, current);
        if (current.workflowStatus !== 'awaiting_upload') {
          throw new VersionConflictError(envelope.expectedVersion, current.revision);
        }
        const photo: IngredientPhotoVersion = {
          ...current,
          id: dependencies.nextId('ingredient-photo-version'),
          revision: current.revision + 1,
          createdAt: dependencies.now(),
          workflowStatus: 'uploaded'
        };
        const record: IdempotencyRecord = {
          operation: 'registerIngredientPhotoUpload',
          key: envelope.idempotencyKey,
          requestFingerprint: expectedFingerprint,
          resultVersionId: photo.id
        };
        return {
          nextState: stateWithPhotoVersion(state, photo, record),
          result: { photo }
        };
      });
    },

    async recognizeIngredientPhoto(
      userId: string,
      envelope: WriteCommandEnvelope<{ readonly photoId: string }>
    ): Promise<IngredientPhotoCommandResult> {
      const expectedFingerprint = commandFingerprint(envelope);
      const initialState = await repository.read(userId);
      const initialReplay = findRecord(
        initialState,
        'recognizeIngredientPhoto',
        envelope.idempotencyKey
      );
      if (initialReplay !== undefined) {
        assertReplay(initialReplay, expectedFingerprint, envelope.idempotencyKey);
        return { photo: resultPhoto(initialState, initialReplay.resultVersionId) };
      }
      const beforeIo = latestPhoto(initialState, envelope.payload.photoId);
      assertExpectedRevision(envelope.expectedVersion, beforeIo);
      if (
        beforeIo.workflowStatus !== 'uploaded'
        && beforeIo.workflowStatus !== 'recognition_failed'
      ) {
        throw new VersionConflictError(envelope.expectedVersion, beforeIo.revision);
      }

      let rawResult;
      try {
        rawResult = await dependencies.vision.recognize({
          privateFileId: beforeIo.expectedPrivateFileId,
          requestId: dependencies.nextId('ingredient-photo-recognition-request')
        });
      } catch {
        throw new ProviderUnavailableError('vision_provider_unavailable');
      }
      const candidates = await normalizeCandidates(
        dependencies,
        beforeIo.photoId,
        rawResult.candidates
      );

      return repository.transact(userId, (state) => {
        const replay = findRecord(
          state,
          'recognizeIngredientPhoto',
          envelope.idempotencyKey
        );
        if (replay !== undefined) {
          assertReplay(replay, expectedFingerprint, envelope.idempotencyKey);
          return {
            nextState: state,
            result: { photo: resultPhoto(state, replay.resultVersionId) }
          };
        }
        const current = latestPhoto(state, envelope.payload.photoId);
        assertExpectedRevision(envelope.expectedVersion, current);
        assertSameStorageIdentity(beforeIo, current);
        if (
          current.workflowStatus !== 'uploaded'
          && current.workflowStatus !== 'recognition_failed'
        ) {
          throw new VersionConflictError(envelope.expectedVersion, current.revision);
        }
        const recognized = candidates.length > 0;
        const photo: IngredientPhotoVersion = {
          ...current,
          id: dependencies.nextId('ingredient-photo-version'),
          revision: current.revision + 1,
          createdAt: dependencies.now(),
          workflowStatus: recognized ? 'recognized' : 'recognition_failed',
          candidates,
          recognitionFailureCode: recognized ? null : 'no_supported_candidate'
        };
        const record: IdempotencyRecord = {
          operation: 'recognizeIngredientPhoto',
          key: envelope.idempotencyKey,
          requestFingerprint: expectedFingerprint,
          resultVersionId: photo.id
        };
        return {
          nextState: stateWithPhotoVersion(state, photo, record),
          result: { photo }
        };
      });
    }
  };
}

export function createIngredientPhotoPlanningService(
  dependencies: MealPlanRecalculationServiceDependencies & IngredientPhotoCommandDependencies
) {
  return {
    ...createMealPlanRecalculationService(dependencies),
    ...createIngredientPhotoCommands(dependencies)
  };
}
