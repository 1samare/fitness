import {
  createInMemoryIngredientPhotoService,
  type ConfirmInMemoryIngredientCandidatePayload
} from '@fitness/application/browser';
import type { NormalizedIngredientCandidate } from '@fitness/domain';
import {
  type FitnessLocalDatabase,
  LOCAL_USER_ID
} from '../../db/database';
import { DexiePlanningRepository } from '../../db/dexie-planning-repository';
import {
  createLocalMealPlanningProviders,
  readLocalTestFoods
} from '../meals/local-meal-providers';
import {
  browserImagePreparationService,
  type PreparedMemoryImage
} from './image-preparation';

export interface RawVisionCandidate {
  readonly name: string;
  readonly confidence: number;
  readonly foodState: 'raw' | 'cooked' | 'dry' | 'unknown';
}

export interface LocalVisionBackend {
  recognize(input: {
    readonly requestId: string;
    readonly dataUrl: string;
    readonly mediaType: PreparedMemoryImage['mediaType'];
  }): Promise<{
    readonly requestId?: string;
    readonly candidates: readonly RawVisionCandidate[];
  }>;
}

export class LocalVisionUnavailableError extends Error {
  public readonly code = 'vision_unavailable' as const;

  public constructor() {
    super('Image recognition is unavailable; use manual inventory entry');
    this.name = 'LocalVisionUnavailableError';
  }
}

export class LocalCandidateNotConfirmedError extends Error {
  public readonly code = 'candidate_not_confirmed' as const;

  public constructor() {
    super('Select a mapped candidate and enter positive integer grams');
    this.name = 'LocalCandidateNotConfirmedError';
  }
}

export type LocalImageCandidateStatus =
  | 'idle'
  | 'ready'
  | 'recognizing'
  | 'candidates'
  | 'confirmed'
  | 'manual_fallback';

export interface LocalImageCandidateSnapshot {
  readonly status: LocalImageCandidateStatus;
  readonly fileName: string | null;
  readonly candidates: readonly NormalizedIngredientCandidate[];
  readonly confirmedCandidateId: string | null;
}

export interface LocalImageCandidateRuntimeOptions {
  readonly database: FitnessLocalDatabase;
  readonly vision: LocalVisionBackend;
  readonly prepareImage?: (file: File) => Promise<PreparedMemoryImage>;
  readonly now?: () => string;
  readonly nextId?: (prefix: string) => string;
  readonly nextIdempotencyKey?: () => string;
}

function browserId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase('zh-CN');
}

export function createLocalImageCandidateRuntime(options: LocalImageCandidateRuntimeOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  const nextId = options.nextId ?? browserId;
  const nextIdempotencyKey = options.nextIdempotencyKey
    ?? (() => browserId('image-confirm'));
  const repository = new DexiePlanningRepository(options.database);
  const providers = createLocalMealPlanningProviders(options.database);
  const confirmation = createInMemoryIngredientPhotoService({
    repository,
    nutrition: providers.nutrition,
    allowTestFixtures: true,
    now,
    nextId
  });
  const prepareImage = options.prepareImage
    ?? ((file: File) => browserImagePreparationService.prepare(file));
  let prepared: PreparedMemoryImage | null = null;
  let photoId: string | null = null;
  let currentSnapshot: LocalImageCandidateSnapshot = {
    status: 'idle',
    fileName: null,
    candidates: [],
    confirmedCandidateId: null
  };

  function releasePreparedImage(): void {
    prepared = null;
  }

  return {
    get snapshot() {
      return currentSnapshot;
    },
    get hasPreparedImage() {
      return prepared !== null;
    },

    async selectFile(file: File): Promise<LocalImageCandidateSnapshot> {
      prepared = await prepareImage(file);
      photoId = nextId('memory-photo');
      currentSnapshot = {
        status: 'ready',
        fileName: file.name,
        candidates: [],
        confirmedCandidateId: null
      };
      return currentSnapshot;
    },

    async recognize(): Promise<LocalImageCandidateSnapshot> {
      if (prepared === null || photoId === null) throw new LocalVisionUnavailableError();
      currentSnapshot = { ...currentSnapshot, status: 'recognizing' };
      try {
        const [result, foods] = await Promise.all([
          options.vision.recognize({
            requestId: nextId('vision-request'),
            dataUrl: prepared.dataUrl,
            mediaType: prepared.mediaType
          }),
          readLocalTestFoods(options.database)
        ]);
        const seen = new Set<string>();
        const candidates: NormalizedIngredientCandidate[] = [];
        for (const candidate of result.candidates.slice(0, 5)) {
          const food = foods.find((item) => (
            normalizedName(item.canonicalNameZh) === normalizedName(candidate.name)
            && (candidate.foodState === 'unknown' || candidate.foodState === item.foodState)
          ));
          if (food === undefined || seen.has(food.nutritionSnapshotId)) continue;
          seen.add(food.nutritionSnapshotId);
          candidates.push({
            id: nextId('image-candidate'),
            foodId: food.foodId,
            nutritionSnapshotId: food.nutritionSnapshotId,
            canonicalNameZh: food.canonicalNameZh,
            confidence: candidate.confidence,
            foodState: food.foodState
          });
        }
        if (candidates.length === 0) throw new LocalVisionUnavailableError();
        currentSnapshot = {
          ...currentSnapshot,
          status: 'candidates',
          candidates
        };
        return currentSnapshot;
      } catch (error: unknown) {
        releasePreparedImage();
        currentSnapshot = {
          ...currentSnapshot,
          status: 'manual_fallback',
          candidates: []
        };
        throw error instanceof LocalVisionUnavailableError
          ? error
          : new LocalVisionUnavailableError();
      }
    },

    async confirm(candidateId: string, confirmedGrams: number) {
      if (prepared === null || photoId === null) throw new LocalCandidateNotConfirmedError();
      const candidate = currentSnapshot.candidates.find((item) => item.id === candidateId);
      if (candidate === undefined
        || !Number.isInteger(confirmedGrams)
        || confirmedGrams <= 0) {
        throw new LocalCandidateNotConfirmedError();
      }
      const state = await repository.read(LOCAL_USER_ID);
      const activeInventory = state.activeInventoryVersionId === null
        ? null
        : state.inventories.find((item) => item.id === state.activeInventoryVersionId) ?? null;
      const payload: ConfirmInMemoryIngredientCandidatePayload = {
        photoId,
        mediaType: prepared.mediaType,
        candidates: currentSnapshot.candidates,
        candidateId,
        confirmedGrams,
        expectedInventoryVersion: activeInventory?.version ?? 0
      };
      const result = await confirmation.confirmCandidate(LOCAL_USER_ID, {
        expectedVersion: 0,
        idempotencyKey: nextIdempotencyKey(),
        payload
      });
      releasePreparedImage();
      currentSnapshot = {
        ...currentSnapshot,
        status: 'confirmed',
        confirmedCandidateId: candidateId
      };
      return result;
    },

    cancel(): LocalImageCandidateSnapshot {
      releasePreparedImage();
      photoId = null;
      currentSnapshot = {
        status: 'idle',
        fileName: null,
        candidates: [],
        confirmedCandidateId: null
      };
      return currentSnapshot;
    }
  };
}

export type LocalImageCandidateRuntime = ReturnType<typeof createLocalImageCandidateRuntime>;
