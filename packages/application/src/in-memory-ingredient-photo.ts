import { nutritionDataSnapshotSchema } from '@fitness/contracts';
import type {
  IdempotencyRecord,
  IngredientPhotoMediaType,
  IngredientPhotoVersion,
  InventoryVersion,
  NormalizedIngredientCandidate,
  NutritionProvider,
  PlanningAggregateState,
  WriteCommandEnvelope
} from '@fitness/domain';
import { requestFingerprint } from './idempotency-fingerprint';
import {
  IdempotencyKeyReuseError,
  VersionConflictError,
  type PlanningRepository
} from './versioned-planning';

export class InMemoryCandidateConfirmationError extends Error {
  public readonly code = 'candidate_not_confirmed' as const;

  public constructor() {
    super('An explicit mapped candidate and positive integer gram amount are required');
    this.name = 'InMemoryCandidateConfirmationError';
  }
}

export interface InMemoryIngredientPhotoServiceDependencies {
  readonly repository: PlanningRepository;
  readonly nutrition: NutritionProvider;
  readonly allowTestFixtures: boolean;
  readonly now: () => string;
  readonly nextId: (prefix: string) => string;
}

export interface ConfirmInMemoryIngredientCandidatePayload {
  readonly photoId: string;
  readonly mediaType: IngredientPhotoMediaType;
  readonly candidates: readonly NormalizedIngredientCandidate[];
  readonly candidateId: string;
  readonly confirmedGrams: number;
  readonly expectedInventoryVersion: number;
}

function fingerprint(
  envelope: WriteCommandEnvelope<ConfirmInMemoryIngredientCandidatePayload>
): string {
  return requestFingerprint({
    expectedVersion: envelope.expectedVersion,
    payload: envelope.payload
  });
}

function activeInventory(state: PlanningAggregateState): InventoryVersion | null {
  if (state.activeInventoryVersionId === null) return null;
  const inventory = state.inventories.find((item) => item.id === state.activeInventoryVersionId);
  if (inventory === undefined) throw new Error('Active inventory is missing');
  return inventory;
}

function assertInventoryVersion(state: PlanningAggregateState, expected: number): InventoryVersion | null {
  const inventory = activeInventory(state);
  const actual = inventory?.version ?? 0;
  if (actual !== expected) throw new VersionConflictError(expected, actual);
  return inventory;
}

function assertInput(payload: ConfirmInMemoryIngredientCandidatePayload): NormalizedIngredientCandidate {
  if (!Number.isInteger(payload.confirmedGrams)
    || payload.confirmedGrams <= 0
    || payload.confirmedGrams > 1_000_000
    || payload.photoId.trim() === ''
    || payload.candidates.length === 0
    || payload.candidates.length > 5
    || new Set(payload.candidates.map((candidate) => candidate.id)).size !== payload.candidates.length) {
    throw new InMemoryCandidateConfirmationError();
  }
  const selected = payload.candidates.find((candidate) => candidate.id === payload.candidateId);
  if (selected === undefined) throw new InMemoryCandidateConfirmationError();
  return selected;
}

function replayResult(
  state: PlanningAggregateState,
  record: Extract<IdempotencyRecord, { readonly operation: 'confirmIngredientCandidate' }>
) {
  const photo = state.ingredientPhotoVersions.find((item) => item.id === record.resultVersionId);
  const inventory = photo?.inventoryVersionId === undefined
    ? undefined
    : state.inventories.find((item) => item.id === photo.inventoryVersionId);
  if (photo === undefined || inventory === undefined) throw new Error('Confirmation replay is corrupt');
  return { photo, inventory };
}

export function createInMemoryIngredientPhotoService(
  dependencies: InMemoryIngredientPhotoServiceDependencies
) {
  return {
    async confirmCandidate(
      userId: string,
      envelope: WriteCommandEnvelope<ConfirmInMemoryIngredientCandidatePayload>
    ) {
      const expectedFingerprint = fingerprint(envelope);
      const before = await dependencies.repository.read(userId);
      const existing = before.idempotencyRecords.find((record): record is Extract<
        IdempotencyRecord,
        { readonly operation: 'confirmIngredientCandidate' }
      > => record.operation === 'confirmIngredientCandidate' && record.key === envelope.idempotencyKey);
      if (existing !== undefined) {
        if (existing.requestFingerprint !== expectedFingerprint) {
          throw new IdempotencyKeyReuseError(envelope.idempotencyKey);
        }
        return replayResult(before, existing);
      }
      if (envelope.expectedVersion !== 0) {
        throw new VersionConflictError(envelope.expectedVersion, 0);
      }
      const selected = assertInput(envelope.payload);
      assertInventoryVersion(before, envelope.payload.expectedInventoryVersion);

      let snapshot: unknown;
      try {
        snapshot = await dependencies.nutrition.getSnapshot(selected.nutritionSnapshotId);
      } catch {
        throw new InMemoryCandidateConfirmationError();
      }
      const parsed = nutritionDataSnapshotSchema.safeParse(snapshot);
      if (!parsed.success
        || parsed.data.foodId !== selected.foodId
        || parsed.data.canonicalNameZh !== selected.canonicalNameZh
        || parsed.data.foodState !== selected.foodState
        || (parsed.data.qualityStatus === 'test_fixture' && !dependencies.allowTestFixtures)) {
        throw new InMemoryCandidateConfirmationError();
      }

      return dependencies.repository.transact(userId, (state) => {
        const replay = state.idempotencyRecords.find((record): record is Extract<
          IdempotencyRecord,
          { readonly operation: 'confirmIngredientCandidate' }
        > => record.operation === 'confirmIngredientCandidate' && record.key === envelope.idempotencyKey);
        if (replay !== undefined) {
          if (replay.requestFingerprint !== expectedFingerprint) {
            throw new IdempotencyKeyReuseError(envelope.idempotencyKey);
          }
          return { nextState: state, result: replayResult(state, replay) };
        }
        const previousInventory = assertInventoryVersion(
          state,
          envelope.payload.expectedInventoryVersion
        );
        const items = [...(previousInventory?.items ?? [])];
        const existingIndex = items.findIndex((item) => (
          item.foodId === selected.foodId
          && item.nutritionSnapshotId === selected.nutritionSnapshotId
        ));
        if (existingIndex >= 0) {
          const item = items[existingIndex];
          if (item === undefined) throw new Error('Inventory item is missing');
          items[existingIndex] = {
            ...item,
            availableGrams: item.availableGrams + envelope.payload.confirmedGrams
          };
        } else {
          items.push({
            foodId: selected.foodId,
            nutritionSnapshotId: selected.nutritionSnapshotId,
            availableGrams: envelope.payload.confirmedGrams
          });
        }
        items.sort((left, right) => (
          `${left.foodId}:${left.nutritionSnapshotId}`
            .localeCompare(`${right.foodId}:${right.nutritionSnapshotId}`)
        ));
        const createdAt = dependencies.now();
        const inventory: InventoryVersion = {
          kind: 'inventory_version',
          id: dependencies.nextId('inventory'),
          userId,
          version: state.inventories.length + 1,
          createdAt,
          items
        };
        const photo: IngredientPhotoVersion = {
          kind: 'ingredient_photo_version',
          id: dependencies.nextId('ingredient-photo-version'),
          photoId: envelope.payload.photoId,
          userId,
          revision: 1,
          createdAt,
          mediaType: envelope.payload.mediaType,
          workflowStatus: 'confirmed',
          candidates: envelope.payload.candidates,
          confirmedCandidateId: selected.id,
          confirmedGrams: envelope.payload.confirmedGrams,
          inventoryVersionId: inventory.id
        };
        const record: IdempotencyRecord = {
          operation: 'confirmIngredientCandidate',
          key: envelope.idempotencyKey,
          requestFingerprint: expectedFingerprint,
          resultVersionId: photo.id
        };
        return {
          nextState: {
            ...state,
            inventories: [...state.inventories, inventory],
            ingredientPhotoVersions: [...state.ingredientPhotoVersions, photo],
            activeInventoryVersionId: inventory.id,
            idempotencyRecords: [...state.idempotencyRecords, record]
          },
          result: { photo, inventory }
        };
      });
    }
  };
}
