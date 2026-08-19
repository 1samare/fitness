import { describe, expect, test, vi } from 'vitest';
import type { Mock } from 'vitest';
import type {
  IngredientPhotoVersion,
  NutritionDataSnapshot,
  NutritionProvider,
  PlanningAggregateState,
  PrivatePhotoStorage,
  VisionCandidate,
  VisionProvider
} from '@fitness/domain';
import { deriveNextPhotoCleanupAt, latestIngredientPhotoVersions } from '@fitness/domain';
import { InMemoryPlanningRepository } from '@fitness/persistence';
import {
  IngredientPhotoNotFoundError,
  PrivatePhotoOwnershipError,
  createIngredientPhotoCommands,
  createIngredientPhotoPlanningService
} from './ingredient-photo';
import { VersionConflictError, type PlanningRepository } from './versioned-planning';

const NOW = '2026-08-19T00:00:00.000Z';
const EXPECTED_FILE_ID = 'cloud://env.bucket/ingredient-photos/photo-a/upload-a.jpg';
const MAXIMUM_FILE_BYTES = 10 * 1024 * 1024;

function snapshot(input: {
  readonly id: string;
  readonly foodId: string;
  readonly canonicalNameZh: string;
  readonly qualityStatus?: 'reviewed' | 'test_fixture';
}): NutritionDataSnapshot {
  return {
    id: input.id,
    foodId: input.foodId,
    canonicalNameZh: input.canonicalNameZh,
    foodGroupId: 'animal_protein',
    sourceId: 'reviewed-source',
    sourceRecordId: `${input.foodId}-source-record`,
    provider: 'reviewed-cache',
    originalUnit: 'per_100_g_edible_portion',
    foodState: 'raw',
    datasetVersion: '2026-08',
    snapshotVersion: 1,
    reviewedAt: NOW,
    qualityStatus: input.qualityStatus ?? 'reviewed',
    allergens: [],
    nutrientsPer100g: {
      energyKcal: 120,
      proteinG: 22,
      fatG: 3,
      carbohydrateG: 0,
      fiberG: 0,
      saturatedFatG: 1,
      addedSugarG: 0
    }
  };
}

const CHICKEN_SNAPSHOT = snapshot({
  id: 'snapshot-chicken-breast-2026-08',
  foodId: 'food-chicken-breast',
  canonicalNameZh: '鸡胸肉'
});

function createSequenceId(ids: readonly string[]): (prefix: string) => string {
  let index = 0;
  return (prefix) => ids[index++] ?? `${prefix}-fallback-${String(index)}`;
}

function defaultNutrition() {
  return {
    resolveCanonicalName: vi.fn((name: string) => Promise.resolve(name === '鸡胸肉'
      ? {
          foodId: CHICKEN_SNAPSHOT.foodId,
          canonicalNameZh: CHICKEN_SNAPSHOT.canonicalNameZh,
          nutritionSnapshotId: CHICKEN_SNAPSHOT.id
        }
      : null)),
    getSnapshot: vi.fn((snapshotId: string) => {
      if (snapshotId !== CHICKEN_SNAPSHOT.id) return Promise.reject(new Error('snapshot_not_found'));
      return Promise.resolve(CHICKEN_SNAPSHOT);
    })
  };
}

function defaultVision(candidates: readonly VisionCandidate[] = [{
  providerCandidateId: 'provider-candidate-chicken',
  name: '鸡胸肉',
  confidence: 0.92,
  foodState: 'raw'
}]): { readonly recognize: Mock<VisionProvider['recognize']> } {
  const recognize: Mock<VisionProvider['recognize']> = vi.fn(() => Promise.resolve({
    providerRequestId: 'provider-request-1',
    candidates
  }));
  return {
    recognize
  };
}

function defaultStorage() {
  return {
    inspectPrivateFile: vi.fn(() => Promise.resolve({
      mediaType: 'image/jpeg' as const,
      sizeBytes: 4
    })),
    deletePrivateFile: vi.fn(() => Promise.resolve('deleted' as const))
  };
}

function createHarness(options: {
  readonly repository?: PlanningRepository;
  readonly nutrition?: NutritionProvider;
  readonly vision?: VisionProvider;
  readonly storage?: PrivatePhotoStorage;
  readonly ids?: readonly string[];
  readonly storageFileIdPrefix?: string;
  readonly allowTestFixtures?: boolean;
} = {}) {
  const repository = options.repository ?? new InMemoryPlanningRepository();
  const nutritionFixture = defaultNutrition();
  const visionFixture = defaultVision();
  const storageFixture = defaultStorage();
  const nutrition = options.nutrition ?? nutritionFixture;
  const vision = options.vision ?? visionFixture;
  const storage = options.storage ?? storageFixture;
  const commands = createIngredientPhotoCommands({
    repository,
    nutrition,
    vision,
    storage,
    now: () => NOW,
    nextId: createSequenceId(options.ids ?? [
      'photo-a',
      'upload-a',
      'photo-version-1',
      'photo-version-2',
      'recognition-request-1',
      'photo-version-3',
      'recognition-request-2',
      'photo-version-4'
    ]),
    storageFileIdPrefix: options.storageFileIdPrefix ?? 'cloud://env.bucket/',
    allowTestFixtures: options.allowTestFixtures ?? true
  });
  return {
    commands,
    nutrition,
    nutritionFixture,
    repository,
    storage,
    storageFixture,
    vision,
    visionFixture
  };
}

type Commands = ReturnType<typeof createIngredientPhotoCommands>;

async function createUpload(commands: Commands) {
  return commands.createIngredientPhotoUpload('user-a', {
    expectedVersion: 0,
    idempotencyKey: 'photo-create-001',
    payload: { mediaType: 'image/jpeg' }
  });
}

async function createAndRegisterPhoto(commands: Commands) {
  await createUpload(commands);
  return commands.registerIngredientPhotoUpload('user-a', {
    expectedVersion: 1,
    idempotencyKey: 'photo-register-001',
    payload: { photoId: 'photo-a', privateFileId: EXPECTED_FILE_ID }
  });
}

async function createRegisterAndRecognize(commands: Commands): Promise<string> {
  await createAndRegisterPhoto(commands);
  const result = await commands.recognizeIngredientPhoto('user-a', {
    expectedVersion: 2,
    idempotencyKey: 'photo-recognize-001',
    payload: { photoId: 'photo-a' }
  });
  const selected = result.photo.candidates[0];
  if (selected === undefined) throw new Error('Expected recognized candidate');
  return selected.id;
}

function confirmationEnvelope(
  candidateId: string,
  overrides: {
    readonly expectedVersion?: number;
    readonly expectedInventoryVersion?: number;
    readonly confirmedGrams?: number;
    readonly idempotencyKey?: string;
    readonly photoId?: string;
  } = {}
) {
  return {
    expectedVersion: overrides.expectedVersion ?? 3,
    idempotencyKey: overrides.idempotencyKey ?? 'photo-confirm-001',
    payload: {
      photoId: overrides.photoId ?? 'photo-a',
      candidateId,
      confirmedGrams: overrides.confirmedGrams ?? 125,
      expectedInventoryVersion: overrides.expectedInventoryVersion ?? 0
    }
  };
}

function latestPhoto(state: PlanningAggregateState, photoId = 'photo-a'): IngredientPhotoVersion {
  const photo = latestIngredientPhotoVersions(state.ingredientPhotoVersions)
    .find((candidate) => candidate.photoId === photoId);
  if (photo === undefined) throw new Error('Expected ingredient photo');
  return photo;
}

async function appendCompetingRevision(
  repository: InMemoryPlanningRepository,
  update: (photo: IngredientPhotoVersion) => IngredientPhotoVersion
): Promise<void> {
  await repository.transact('user-a', (state) => {
    const competing = update(latestPhoto(state));
    const versions = [...state.ingredientPhotoVersions, competing];
    return {
      nextState: {
        ...state,
        ingredientPhotoVersions: versions,
        nextPhotoCleanupAt: deriveNextPhotoCleanupAt(versions)
      },
      result: undefined
    };
  });
}

function planningOutputs(state: PlanningAggregateState) {
  return {
    inventories: state.inventories,
    dailyEnergyTargets: state.dailyEnergyTargets,
    dailyNutritionTargets: state.dailyNutritionTargets,
    mealPlans: state.mealPlans,
    recalculationJobs: state.recalculationJobs,
    outboxEvents: state.outboxEvents
  };
}

async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('Expected operation to reject');
}

function errorText(error: unknown): string {
  return `${String(error)} ${JSON.stringify(error)}`;
}

describe('ingredient photo commands', () => {
  test('composes photo commands with the existing phase-four planning service', () => {
    const { nutrition, repository, storage, vision } = createHarness();
    const service = createIngredientPhotoPlanningService({
      repository,
      nutrition,
      vision,
      storage,
      now: () => NOW,
      nextId: createSequenceId(['unused']),
      storageFileIdPrefix: 'cloud://env.bucket/',
      allowTestFixtures: true,
      providers: {
        nutrition,
        recipes: {
          getByVersionId: async () => Promise.reject(new Error('not_used'))
        },
        menus: {
          getActiveCatalog: async () => Promise.reject(new Error('not_used')),
          getMenuByVersionId: async () => Promise.reject(new Error('not_used'))
        },
        allowTestFixtures: true
      }
    });

    expect(typeof service.getCurrentContext).toBe('function');
    expect(typeof service.createIngredientPhotoUpload).toBe('function');
    expect(typeof service.registerIngredientPhotoUpload).toBe('function');
    expect(typeof service.recognizeIngredientPhoto).toBe('function');
  });

  test('creates a private upload session with cleanup due before 24 hours', async () => {
    const { commands, repository } = createHarness();

    const result = await createUpload(commands);

    expect(result).toMatchObject({
      cloudPath: 'ingredient-photos/photo-a/upload-a.jpg',
      photo: {
        photoId: 'photo-a',
        revision: 1,
        workflowStatus: 'awaiting_upload',
        deleteDueAt: '2026-08-19T23:00:00.000Z'
      }
    });
    const state = await repository.read('user-a');
    expect(state.ingredientPhotoVersions[0]?.expectedPrivateFileId).toBe(EXPECTED_FILE_ID);
    expect(state.nextPhotoCleanupAt).toBe('2026-08-19T23:00:00.000Z');
  });

  test('normalizes the storage prefix and derives the extension only from media type', async () => {
    const { commands } = createHarness({ storageFileIdPrefix: 'cloud://env.bucket////' });

    await expect(commands.createIngredientPhotoUpload('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'photo-create-png-001',
      payload: { mediaType: 'image/png' }
    })).resolves.toMatchObject({
      cloudPath: 'ingredient-photos/photo-a/upload-a.png',
      photo: { expectedPrivateFileId: 'cloud://env.bucket/ingredient-photos/photo-a/upload-a.png' }
    });
  });

  test('rejects a non-CloudBase storage prefix before creating a command service', () => {
    expect(() => createHarness({ storageFileIdPrefix: 'https://public.example/' }))
      .toThrow(PrivatePhotoOwnershipError);
  });

  test('creates photos against the latest logical-photo count rather than revision count', async () => {
    const { commands } = createHarness({
      ids: [
        'photo-a', 'upload-a', 'photo-version-1', 'photo-version-2',
        'photo-b', 'upload-b', 'photo-version-b1'
      ]
    });
    await createAndRegisterPhoto(commands);

    await expect(commands.createIngredientPhotoUpload('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'photo-create-002',
      payload: { mediaType: 'image/jpeg' }
    })).resolves.toMatchObject({ photo: { photoId: 'photo-b', revision: 1 } });
  });

  test('registers only the exact private fileID after byte inspection', async () => {
    const { commands, storageFixture } = createHarness();
    await createUpload(commands);

    await expect(commands.registerIngredientPhotoUpload('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'photo-register-001',
      payload: { photoId: 'photo-a', privateFileId: EXPECTED_FILE_ID }
    })).resolves.toMatchObject({ photo: { workflowStatus: 'uploaded', revision: 2 } });
    expect(storageFixture.inspectPrivateFile).toHaveBeenCalledWith({ privateFileId: EXPECTED_FILE_ID });
  });

  test('rejects another fileID without inspecting it', async () => {
    const { commands, storageFixture } = createHarness();
    await createUpload(commands);

    await expect(commands.registerIngredientPhotoUpload('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'photo-register-wrong-file-001',
      payload: { photoId: 'photo-a', privateFileId: 'cloud://env.bucket/other/photo.jpg' }
    })).rejects.toBeInstanceOf(PrivatePhotoOwnershipError);
    expect(storageFixture.inspectPrivateFile).not.toHaveBeenCalled();
  });

  test.each([
    ['different inspected media type', { mediaType: 'image/png' as const, sizeBytes: 8 }],
    ['oversized inspected bytes', { mediaType: 'image/jpeg' as const, sizeBytes: MAXIMUM_FILE_BYTES + 1 }]
  ])('rejects %s without registering an upload', async (_label, inspected) => {
    const storage: PrivatePhotoStorage = {
      inspectPrivateFile: vi.fn(() => Promise.resolve(inspected)),
      deletePrivateFile: vi.fn(() => Promise.resolve('deleted' as const))
    };
    const { commands, repository } = createHarness({ storage });
    await createUpload(commands);

    await expect(commands.registerIngredientPhotoUpload('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'photo-register-invalid-object-001',
      payload: { photoId: 'photo-a', privateFileId: EXPECTED_FILE_ID }
    })).rejects.toBeInstanceOf(PrivatePhotoOwnershipError);
    expect(latestPhoto(await repository.read('user-a')).workflowStatus).toBe('awaiting_upload');
  });

  test('rejects a stale photo revision before inspecting storage', async () => {
    const { commands, storageFixture } = createHarness();
    await createUpload(commands);

    await expect(commands.registerIngredientPhotoUpload('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'photo-register-stale-001',
      payload: { photoId: 'photo-a', privateFileId: EXPECTED_FILE_ID }
    })).rejects.toEqual(new VersionConflictError(0, 1));
    expect(storageFixture.inspectPrivateFile).not.toHaveBeenCalled();
  });

  test('rejects a status and revision change that happens during storage inspection', async () => {
    const repository = new InMemoryPlanningRepository();
    const storage: PrivatePhotoStorage = {
      inspectPrivateFile: vi.fn(async () => {
        await appendCompetingRevision(repository, (photo) => ({
          ...photo,
          id: 'concurrent-photo-version-2',
          revision: 2,
          createdAt: '2026-08-19T00:01:00.000Z',
          workflowStatus: 'uploaded'
        }));
        return { mediaType: 'image/jpeg' as const, sizeBytes: 4 };
      }),
      deletePrivateFile: vi.fn(() => Promise.resolve('deleted' as const))
    };
    const { commands } = createHarness({ repository, storage });
    await createUpload(commands);

    await expect(commands.registerIngredientPhotoUpload('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'photo-register-race-001',
      payload: { photoId: 'photo-a', privateFileId: EXPECTED_FILE_ID }
    })).rejects.toEqual(new VersionConflictError(1, 2));
    expect((await repository.read('user-a')).ingredientPhotoVersions).toHaveLength(2);
  });

  test('maps storage inspection failures to a sanitized application error', async () => {
    const privateDetail = `download failed for ${EXPECTED_FILE_ID}`;
    const storage: PrivatePhotoStorage = {
      inspectPrivateFile: vi.fn(() => Promise.reject(new Error(privateDetail))),
      deletePrivateFile: vi.fn(() => Promise.resolve('deleted' as const))
    };
    const { commands } = createHarness({ storage });
    await createUpload(commands);

    const error = await captureError(() => commands.registerIngredientPhotoUpload('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'photo-register-storage-down-001',
      payload: { photoId: 'photo-a', privateFileId: EXPECTED_FILE_ID }
    }));

    expect(error).toMatchObject({
      code: 'storage_unavailable',
      message: 'Private photo storage is unavailable'
    });
    expect(errorText(error)).not.toContain(privateDetail);
    expect(errorText(error)).not.toContain(EXPECTED_FILE_ID);
  });

  test('replays registration without inspecting storage twice', async () => {
    const { commands, repository, storageFixture } = createHarness();
    await createUpload(commands);
    const envelope = {
      expectedVersion: 1,
      idempotencyKey: 'photo-register-replay-001',
      payload: { photoId: 'photo-a', privateFileId: EXPECTED_FILE_ID }
    } as const;

    const first = await commands.registerIngredientPhotoUpload('user-a', envelope);
    const replay = await commands.registerIngredientPhotoUpload('user-a', envelope);

    expect(replay).toEqual(first);
    expect(storageFixture.inspectPrivateFile).toHaveBeenCalledTimes(1);
    expect((await repository.read('user-a')).ingredientPhotoVersions).toHaveLength(2);
  });

  test('does not reveal another user photo through registration', async () => {
    const { commands, storageFixture } = createHarness();
    await createUpload(commands);

    await expect(commands.registerIngredientPhotoUpload('user-b', {
      expectedVersion: 1,
      idempotencyKey: 'photo-register-cross-user-001',
      payload: { photoId: 'photo-a', privateFileId: EXPECTED_FILE_ID }
    })).rejects.toBeInstanceOf(IngredientPhotoNotFoundError);
    expect(storageFixture.inspectPrivateFile).not.toHaveBeenCalled();
  });

  test('maps reviewed candidates and leaves every planning output unchanged', async () => {
    const vision = defaultVision([
      { providerCandidateId: 'raw-1', name: '鸡胸肉', confidence: 0.92, foodState: 'raw' },
      { providerCandidateId: 'raw-2', name: '未知状态', confidence: 0.99, foodState: 'unknown' },
      { providerCandidateId: 'raw-3', name: '无法映射', confidence: 0.8, foodState: 'raw' }
    ]);
    const { commands, repository } = createHarness({ vision });
    await createAndRegisterPhoto(commands);
    const before = await repository.read('user-a');

    const result = await commands.recognizeIngredientPhoto('user-a', {
      expectedVersion: 2,
      idempotencyKey: 'photo-recognize-001',
      payload: { photoId: 'photo-a' }
    });

    expect(result.photo.candidates).toHaveLength(1);
    const candidate = result.photo.candidates[0];
    if (candidate === undefined) throw new Error('Expected a mapped candidate');
    expect(typeof candidate.id).toBe('string');
    expect([candidate]).toEqual([{
      id: candidate.id,
      foodId: 'food-chicken-breast',
      nutritionSnapshotId: 'snapshot-chicken-breast-2026-08',
      canonicalNameZh: '鸡胸肉',
      confidence: 0.92,
      foodState: 'raw'
    }]);
    const after = await repository.read('user-a');
    expect(planningOutputs(after)).toEqual(planningOutputs(before));
    expect(JSON.stringify(after.ingredientPhotoVersions)).not.toContain('无法映射');
    expect(JSON.stringify(after.ingredientPhotoVersions)).not.toContain('provider-request-1');
  });

  test('deduplicates by canonical food identity, sorts stably, and keeps at most five candidates', async () => {
    const definitions = [
      ['food-a', 0.55], ['food-g', 0.71], ['food-c', 0.9], ['food-a', 0.95],
      ['food-b', 0.9], ['food-d', 0.8], ['food-e', 0.7], ['food-f', 0.6]
    ] as const;
    const snapshots = new Map(definitions.map(([foodId]) => {
      const value = snapshot({ id: `snapshot-${foodId}`, foodId, canonicalNameZh: `食材${foodId}` });
      return [value.id, value] as const;
    }));
    const nutrition: NutritionProvider = {
      resolveCanonicalName: vi.fn((name: string) => {
        const foodId = name.replace('候选-', '');
        return Promise.resolve({
          foodId,
          canonicalNameZh: `食材${foodId}`,
          nutritionSnapshotId: `snapshot-${foodId}`
        });
      }),
      getSnapshot: vi.fn((id: string) => {
        const value = snapshots.get(id);
        if (value === undefined) return Promise.reject(new Error('snapshot_not_found'));
        return Promise.resolve(value);
      })
    };
    const vision = defaultVision(definitions.map(([foodId, confidence], index) => ({
      providerCandidateId: `raw-${String(index)}`,
      name: `候选-${foodId}`,
      confidence,
      foodState: 'raw'
    })));
    const { commands } = createHarness({ nutrition, vision });
    await createAndRegisterPhoto(commands);

    const result = await commands.recognizeIngredientPhoto('user-a', {
      expectedVersion: 2,
      idempotencyKey: 'photo-recognize-order-001',
      payload: { photoId: 'photo-a' }
    });

    expect(result.photo.candidates.map((candidate) => [candidate.foodId, candidate.confidence]))
      .toEqual([
        ['food-a', 0.95],
        ['food-b', 0.9],
        ['food-c', 0.9],
        ['food-d', 0.8],
        ['food-g', 0.71]
      ]);
  });

  test('records recognition_failed when every candidate is unsupported', async () => {
    const { commands } = createHarness({
      vision: defaultVision([
        { providerCandidateId: 'raw-1', name: '未知状态', confidence: 0.99, foodState: 'unknown' },
        { providerCandidateId: 'raw-2', name: '无法映射', confidence: 0.8, foodState: 'raw' }
      ])
    });
    await createAndRegisterPhoto(commands);

    await expect(commands.recognizeIngredientPhoto('user-a', {
      expectedVersion: 2,
      idempotencyKey: 'photo-recognize-empty-001',
      payload: { photoId: 'photo-a' }
    })).resolves.toMatchObject({
      photo: {
        revision: 3,
        workflowStatus: 'recognition_failed',
        recognitionFailureCode: 'no_supported_candidate',
        candidates: []
      }
    });
  });

  test('allows a failed photo to be recognized successfully on a later retry', async () => {
    const vision: VisionProvider = {
      recognize: vi.fn()
        .mockResolvedValueOnce({ providerRequestId: 'provider-failed', candidates: [] })
        .mockResolvedValueOnce({
          providerRequestId: 'provider-success',
          candidates: [{
            providerCandidateId: 'raw-chicken',
            name: '鸡胸肉',
            confidence: 0.92,
            foodState: 'raw'
          }]
        })
    };
    const { commands } = createHarness({ vision });
    await createAndRegisterPhoto(commands);
    await commands.recognizeIngredientPhoto('user-a', {
      expectedVersion: 2,
      idempotencyKey: 'photo-recognize-failed-001',
      payload: { photoId: 'photo-a' }
    });

    await expect(commands.recognizeIngredientPhoto('user-a', {
      expectedVersion: 3,
      idempotencyKey: 'photo-recognize-retry-001',
      payload: { photoId: 'photo-a' }
    })).resolves.toMatchObject({
      photo: { revision: 4, workflowStatus: 'recognized' }
    });
  });

  test('drops test-fixture nutrition sources unless fixture mode is explicitly enabled', async () => {
    const fixtureSnapshot = snapshot({
      id: CHICKEN_SNAPSHOT.id,
      foodId: CHICKEN_SNAPSHOT.foodId,
      canonicalNameZh: CHICKEN_SNAPSHOT.canonicalNameZh,
      qualityStatus: 'test_fixture'
    });
    const nutrition = defaultNutrition();
    nutrition.getSnapshot = vi.fn(() => Promise.resolve(fixtureSnapshot));
    const { commands } = createHarness({ nutrition, allowTestFixtures: false });
    await createAndRegisterPhoto(commands);

    await expect(commands.recognizeIngredientPhoto('user-a', {
      expectedVersion: 2,
      idempotencyKey: 'photo-recognize-production-source-001',
      payload: { photoId: 'photo-a' }
    })).resolves.toMatchObject({
      photo: { workflowStatus: 'recognition_failed', candidates: [] }
    });
  });

  test('drops a candidate whose food state disagrees with its nutrition snapshot', async () => {
    const { commands } = createHarness({
      vision: defaultVision([{
        providerCandidateId: 'raw-cooked-chicken',
        name: '鸡胸肉',
        confidence: 0.92,
        foodState: 'cooked'
      }])
    });
    await createAndRegisterPhoto(commands);

    await expect(commands.recognizeIngredientPhoto('user-a', {
      expectedVersion: 2,
      idempotencyKey: 'photo-recognize-state-mismatch-001',
      payload: { photoId: 'photo-a' }
    })).resolves.toMatchObject({
      photo: {
        workflowStatus: 'recognition_failed',
        recognitionFailureCode: 'no_supported_candidate',
        candidates: []
      }
    });
  });

  test.each([
    ['canonical name resolution', (): NutritionProvider => ({
      resolveCanonicalName: vi.fn(() => Promise.reject(
        new Error(`nutrition lookup leaked ${EXPECTED_FILE_ID}`)
      )),
      getSnapshot: vi.fn(() => Promise.resolve(CHICKEN_SNAPSHOT))
    })],
    ['snapshot loading', (): NutritionProvider => ({
      resolveCanonicalName: vi.fn((name: string) => Promise.resolve(name === '鸡胸肉'
        ? {
            foodId: CHICKEN_SNAPSHOT.foodId,
            canonicalNameZh: CHICKEN_SNAPSHOT.canonicalNameZh,
            nutritionSnapshotId: CHICKEN_SNAPSHOT.id
          }
        : null)),
      getSnapshot: vi.fn(() => Promise.reject(
        new Error(`snapshot provider leaked ${CHICKEN_SNAPSHOT.id}`)
      ))
    })]
  ])('maps %s failures to a sanitized nutrition Provider error', async (_label, createNutrition) => {
    const { commands } = createHarness({ nutrition: createNutrition() });
    await createAndRegisterPhoto(commands);

    const error = await captureError(() => commands.recognizeIngredientPhoto('user-a', {
      expectedVersion: 2,
      idempotencyKey: 'photo-recognize-nutrition-down-001',
      payload: { photoId: 'photo-a' }
    }));

    expect(error).toMatchObject({
      code: 'provider_unavailable',
      reason: 'nutrition_source_unavailable'
    });
    expect(errorText(error)).not.toContain(EXPECTED_FILE_ID);
    expect(errorText(error)).not.toContain(CHICKEN_SNAPSHOT.id);
  });

  test('replays recognition without calling vision or nutrition twice', async () => {
    const { commands, nutritionFixture, repository, visionFixture } = createHarness();
    await createAndRegisterPhoto(commands);
    const envelope = {
      expectedVersion: 2,
      idempotencyKey: 'photo-recognize-replay-001',
      payload: { photoId: 'photo-a' }
    } as const;

    const first = await commands.recognizeIngredientPhoto('user-a', envelope);
    const replay = await commands.recognizeIngredientPhoto('user-a', envelope);

    expect(replay).toEqual(first);
    expect(visionFixture.recognize.mock.calls).toHaveLength(1);
    expect(nutritionFixture.resolveCanonicalName.mock.calls).toHaveLength(1);
    expect(nutritionFixture.getSnapshot.mock.calls).toHaveLength(1);
    expect((await repository.read('user-a')).ingredientPhotoVersions).toHaveLength(3);
  });

  test('sanitizes vision Provider failures and leaves the uploaded photo unchanged', async () => {
    const privateDetail = `private provider detail for ${EXPECTED_FILE_ID}`;
    const providerError = Object.assign(new Error(privateDetail), {
      code: 'provider_unavailable'
    });
    const vision: VisionProvider = {
      recognize: vi.fn(() => Promise.reject(providerError))
    };
    const { commands, repository } = createHarness({ vision });
    await createAndRegisterPhoto(commands);

    const error = await captureError(() => commands.recognizeIngredientPhoto('user-a', {
      expectedVersion: 2,
      idempotencyKey: 'photo-recognize-provider-down-001',
      payload: { photoId: 'photo-a' }
    }));
    expect(error).toMatchObject({
      code: 'provider_unavailable',
      reason: 'vision_provider_unavailable'
    });
    expect(errorText(error)).not.toContain(privateDetail);
    expect(errorText(error)).not.toContain(EXPECTED_FILE_ID);
    expect(latestPhoto(await repository.read('user-a'))).toMatchObject({
      revision: 2,
      workflowStatus: 'uploaded'
    });
  });

  test('rejects a concurrent photo revision after Provider completion without partial command state', async () => {
    const repository = new InMemoryPlanningRepository();
    const vision: VisionProvider = {
      recognize: vi.fn(async () => {
        await appendCompetingRevision(repository, (photo) => ({
          ...photo,
          id: 'concurrent-photo-version-3',
          revision: 3,
          createdAt: '2026-08-19T00:02:00.000Z',
          workflowStatus: 'recognition_failed',
          recognitionFailureCode: 'no_supported_candidate'
        }));
        return {
          providerRequestId: 'provider-request-race',
          candidates: [{
            providerCandidateId: 'raw-chicken',
            name: '鸡胸肉',
            confidence: 0.92,
            foodState: 'raw' as const
          }]
        };
      })
    };
    const { commands } = createHarness({ repository, vision });
    await createAndRegisterPhoto(commands);

    await expect(commands.recognizeIngredientPhoto('user-a', {
      expectedVersion: 2,
      idempotencyKey: 'photo-recognize-race-001',
      payload: { photoId: 'photo-a' }
    })).rejects.toEqual(new VersionConflictError(2, 3));
    const state = await repository.read('user-a');
    expect(state.ingredientPhotoVersions).toHaveLength(3);
    expect(state.idempotencyRecords.some((record) => (
      record.operation === 'recognizeIngredientPhoto'
    ))).toBe(false);
  });

  test('checks recognition version and identity before calling the Provider', async () => {
    const { commands, visionFixture } = createHarness();
    await createAndRegisterPhoto(commands);

    await expect(commands.recognizeIngredientPhoto('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'photo-recognize-stale-001',
      payload: { photoId: 'photo-a' }
    })).rejects.toEqual(new VersionConflictError(1, 2));
    await expect(commands.recognizeIngredientPhoto('user-a', {
      expectedVersion: 2,
      idempotencyKey: 'photo-recognize-missing-001',
      payload: { photoId: 'missing-photo' }
    })).rejects.toBeInstanceOf(IngredientPhotoNotFoundError);
    expect(visionFixture.recognize.mock.calls).toHaveLength(0);
  });

  test('atomically confirms a selected candidate and creates one inventory version', async () => {
    const { commands, repository, storage } = createHarness();
    const candidateId = await createRegisterAndRecognize(commands);

    const result = await commands.confirmIngredientCandidate(
      'user-a',
      confirmationEnvelope(candidateId)
    );

    expect(result.photo).toMatchObject({
      workflowStatus: 'confirmed',
      storageStatus: 'cleanup_pending',
      confirmedCandidateId: candidateId,
      confirmedGrams: 125,
      inventoryVersionId: result.inventory.id,
      nextCleanupAt: NOW
    });
    expect(result.inventory).toMatchObject({
      version: 1,
      items: [{
        foodId: 'food-chicken-breast',
        nutritionSnapshotId: 'snapshot-chicken-breast-2026-08',
        availableGrams: 125
      }]
    });
    const state = await repository.read('user-a');
    expect(state.ingredientPhotoVersions).toHaveLength(4);
    expect(state.inventories).toHaveLength(1);
    expect(state.activeInventoryVersionId).toBe(result.inventory.id);
    expect(vi.mocked(storage).deletePrivateFile.mock.calls).toHaveLength(0);
  });

  test('merges only the selected food snapshot grams and sorts the next inventory', async () => {
    const { commands, repository } = createHarness();
    const candidateId = await createRegisterAndRecognize(commands);
    await repository.transact('user-a', (state) => ({
      nextState: {
        ...state,
        inventories: [{
          kind: 'inventory_version',
          id: 'inventory-existing-1',
          userId: 'user-a',
          version: 1,
          createdAt: '2026-08-18T00:00:00.000Z',
          items: [{
            foodId: 'food-chicken-breast',
            nutritionSnapshotId: 'snapshot-chicken-breast-2026-08',
            availableGrams: 40
          }, {
            foodId: 'food-apple',
            nutritionSnapshotId: 'snapshot-apple-2026-08',
            availableGrams: 300
          }]
        }],
        activeInventoryVersionId: 'inventory-existing-1'
      },
      result: undefined
    }));

    const result = await commands.confirmIngredientCandidate('user-a', confirmationEnvelope(
      candidateId,
      { expectedInventoryVersion: 1 }
    ));

    expect(result.inventory.items).toEqual([{
      foodId: 'food-apple',
      nutritionSnapshotId: 'snapshot-apple-2026-08',
      availableGrams: 300
    }, {
      foodId: 'food-chicken-breast',
      nutritionSnapshotId: 'snapshot-chicken-breast-2026-08',
      availableGrams: 165
    }]);
  });

  test('keeps an existing snapshot when confirming a newer snapshot for the same food', async () => {
    const { commands, repository } = createHarness();
    const candidateId = await createRegisterAndRecognize(commands);
    await repository.transact('user-a', (state) => ({
      nextState: {
        ...state,
        inventories: [{
          kind: 'inventory_version',
          id: 'inventory-existing-1',
          userId: 'user-a',
          version: 1,
          createdAt: '2026-08-18T00:00:00.000Z',
          items: [{
            foodId: 'food-chicken-breast',
            nutritionSnapshotId: 'snapshot-chicken-breast-2026-07',
            availableGrams: 40
          }]
        }],
        activeInventoryVersionId: 'inventory-existing-1'
      },
      result: undefined
    }));

    const result = await commands.confirmIngredientCandidate('user-a', confirmationEnvelope(
      candidateId,
      { expectedInventoryVersion: 1 }
    ));

    expect(result.inventory.items).toEqual([{
      foodId: 'food-chicken-breast',
      nutritionSnapshotId: 'snapshot-chicken-breast-2026-07',
      availableGrams: 40
    }, {
      foodId: 'food-chicken-breast',
      nutritionSnapshotId: 'snapshot-chicken-breast-2026-08',
      availableGrams: 125
    }]);
    const state = await repository.read('user-a');
    expect(state.inventories).toHaveLength(2);
    expect(state.activeInventoryVersionId).toBe(result.inventory.id);
  });

  test('requires an explicit candidate selection without loading nutrition', async () => {
    const { commands, nutrition } = createHarness();
    await createRegisterAndRecognize(commands);
    const callsBeforeConfirmation = vi.mocked(nutrition).getSnapshot.mock.calls.length;

    await expect(commands.confirmIngredientCandidate(
      'user-a',
      confirmationEnvelope('')
    )).rejects.toMatchObject({ code: 'candidate_confirmation_required' });
    expect(vi.mocked(nutrition).getSnapshot.mock.calls).toHaveLength(callsBeforeConfirmation);
  });

  test('rejects a candidate selected from another photo', async () => {
    const { commands, nutrition } = createHarness({
      ids: [
        'photo-a', 'upload-a', 'photo-a-version-1', 'photo-a-version-2',
        'photo-a-recognition-request', 'photo-a-version-3',
        'photo-b', 'upload-b', 'photo-b-version-1', 'photo-b-version-2',
        'photo-b-recognition-request', 'photo-b-version-3'
      ]
    });
    await createRegisterAndRecognize(commands);
    await commands.createIngredientPhotoUpload('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'photo-create-002',
      payload: { mediaType: 'image/jpeg' }
    });
    await commands.registerIngredientPhotoUpload('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'photo-register-002',
      payload: {
        photoId: 'photo-b',
        privateFileId: 'cloud://env.bucket/ingredient-photos/photo-b/upload-b.jpg'
      }
    });
    const second = await commands.recognizeIngredientPhoto('user-a', {
      expectedVersion: 2,
      idempotencyKey: 'photo-recognize-002',
      payload: { photoId: 'photo-b' }
    });
    const foreignCandidate = second.photo.candidates[0];
    if (foreignCandidate === undefined) throw new Error('Expected second photo candidate');
    const callsBeforeConfirmation = vi.mocked(nutrition).getSnapshot.mock.calls.length;

    await expect(commands.confirmIngredientCandidate(
      'user-a',
      confirmationEnvelope(foreignCandidate.id)
    )).rejects.toMatchObject({ code: 'candidate_confirmation_required' });
    expect(vi.mocked(nutrition).getSnapshot.mock.calls).toHaveLength(callsBeforeConfirmation);
  });

  test.each([0, 12.5])('rejects impossible confirmed gram value %s inside the application boundary', async (confirmedGrams) => {
    const { commands, nutrition } = createHarness();
    const candidateId = await createRegisterAndRecognize(commands);
    const callsBeforeConfirmation = vi.mocked(nutrition).getSnapshot.mock.calls.length;

    await expect(commands.confirmIngredientCandidate('user-a', confirmationEnvelope(
      candidateId,
      { confirmedGrams }
    ))).rejects.toMatchObject({ code: 'candidate_confirmation_required' });
    expect(vi.mocked(nutrition).getSnapshot.mock.calls).toHaveLength(callsBeforeConfirmation);
  });

  test('rejects stale photo and inventory versions before loading nutrition', async () => {
    const { commands, nutrition } = createHarness();
    const candidateId = await createRegisterAndRecognize(commands);
    const callsBeforeConfirmation = vi.mocked(nutrition).getSnapshot.mock.calls.length;

    await expect(commands.confirmIngredientCandidate('user-a', confirmationEnvelope(
      candidateId,
      { expectedVersion: 2, idempotencyKey: 'photo-confirm-stale-photo' }
    ))).rejects.toEqual(new VersionConflictError(2, 3));
    await expect(commands.confirmIngredientCandidate('user-a', confirmationEnvelope(
      candidateId,
      { expectedInventoryVersion: 1, idempotencyKey: 'photo-confirm-stale-inventory' }
    ))).rejects.toEqual(new VersionConflictError(1, 0));
    expect(vi.mocked(nutrition).getSnapshot.mock.calls).toHaveLength(callsBeforeConfirmation);
  });

  test('does not reveal another user photo through confirmation', async () => {
    const { commands, nutrition } = createHarness();
    const candidateId = await createRegisterAndRecognize(commands);
    const callsBeforeConfirmation = vi.mocked(nutrition).getSnapshot.mock.calls.length;

    await expect(commands.confirmIngredientCandidate(
      'user-b',
      confirmationEnvelope(candidateId)
    )).rejects.toBeInstanceOf(IngredientPhotoNotFoundError);
    expect(vi.mocked(nutrition).getSnapshot.mock.calls).toHaveLength(callsBeforeConfirmation);
  });

  test('rejects nutrition snapshot identity drift without changing state', async () => {
    const nutrition = defaultNutrition();
    const { commands, repository } = createHarness({ nutrition });
    const candidateId = await createRegisterAndRecognize(commands);
    const before = await repository.read('user-a');
    vi.mocked(nutrition).getSnapshot.mockResolvedValue({
      ...CHICKEN_SNAPSHOT,
      foodId: 'food-drifted'
    });

    await expect(commands.confirmIngredientCandidate(
      'user-a',
      confirmationEnvelope(candidateId)
    )).rejects.toMatchObject({ code: 'candidate_confirmation_required' });
    expect(await repository.read('user-a')).toEqual(before);
  });

  test('rejects a test-fixture snapshot during confirmation when fixture mode is disabled', async () => {
    const nutrition = defaultNutrition();
    const { commands, repository } = createHarness({
      nutrition,
      allowTestFixtures: false
    });
    const candidateId = await createRegisterAndRecognize(commands);
    const before = await repository.read('user-a');
    vi.mocked(nutrition).getSnapshot.mockResolvedValue(snapshot({
      id: CHICKEN_SNAPSHOT.id,
      foodId: CHICKEN_SNAPSHOT.foodId,
      canonicalNameZh: CHICKEN_SNAPSHOT.canonicalNameZh,
      qualityStatus: 'test_fixture'
    }));

    await expect(commands.confirmIngredientCandidate(
      'user-a',
      confirmationEnvelope(candidateId)
    )).rejects.toMatchObject({ code: 'candidate_confirmation_required' });
    expect(await repository.read('user-a')).toEqual(before);
  });

  test('rechecks the current inventory version after snapshot I/O', async () => {
    const repository = new InMemoryPlanningRepository();
    const nutrition = defaultNutrition();
    const originalGetSnapshot = nutrition.getSnapshot.bind(nutrition);
    let snapshotLoads = 0;
    nutrition.getSnapshot = vi.fn(async (snapshotId: string) => {
      snapshotLoads += 1;
      if (snapshotLoads === 2) {
        await repository.transact('user-a', (state) => ({
          nextState: {
            ...state,
            inventories: [{
              kind: 'inventory_version',
              id: 'concurrent-inventory-1',
              userId: 'user-a',
              version: 1,
              createdAt: '2026-08-19T00:01:00.000Z',
              items: [{
                foodId: 'food-apple',
                nutritionSnapshotId: 'snapshot-apple-2026-08',
                availableGrams: 300
              }]
            }],
            activeInventoryVersionId: 'concurrent-inventory-1'
          },
          result: undefined
        }));
      }
      return originalGetSnapshot(snapshotId);
    });
    const { commands } = createHarness({ repository, nutrition });
    const candidateId = await createRegisterAndRecognize(commands);

    await expect(commands.confirmIngredientCandidate(
      'user-a',
      confirmationEnvelope(candidateId)
    )).rejects.toEqual(new VersionConflictError(0, 1));
    const state = await repository.read('user-a');
    expect(state.ingredientPhotoVersions).toHaveLength(3);
    expect(state.inventories).toHaveLength(1);
    expect(state.idempotencyRecords.some((record) => (
      record.operation === 'confirmIngredientCandidate'
    ))).toBe(false);
  });

  test('sanitizes nutrition Provider failure during confirmation', async () => {
    const nutrition = defaultNutrition();
    const { commands } = createHarness({ nutrition });
    const candidateId = await createRegisterAndRecognize(commands);
    const privateDetail = `snapshot failed for ${CHICKEN_SNAPSHOT.id}`;
    vi.mocked(nutrition).getSnapshot.mockRejectedValue(new Error(privateDetail));

    const error = await captureError(() => commands.confirmIngredientCandidate(
      'user-a',
      confirmationEnvelope(candidateId)
    ));

    expect(error).toMatchObject({
      code: 'provider_unavailable',
      reason: 'nutrition_source_unavailable'
    });
    expect(errorText(error)).not.toContain(privateDetail);
    expect(errorText(error)).not.toContain(CHICKEN_SNAPSHOT.id);
  });

  test('leaves photo and inventory versions unchanged when repository commit fails', async () => {
    const base = new InMemoryPlanningRepository();
    const commitError = new Error('repository_commit_failed');
    let failCommit = false;
    const repository: PlanningRepository = {
      read: (userId) => base.read(userId),
      transact: async <TResult>(userId: string, operation: Parameters<PlanningRepository['transact']>[1]) => {
        if (!failCommit) return base.transact(userId, operation) as Promise<TResult>;
        operation(await base.read(userId));
        throw commitError;
      }
    };
    const { commands } = createHarness({ repository });
    const candidateId = await createRegisterAndRecognize(commands);
    const before = await base.read('user-a');
    failCommit = true;

    await expect(commands.confirmIngredientCandidate(
      'user-a',
      confirmationEnvelope(candidateId)
    )).rejects.toBe(commitError);
    const after = await base.read('user-a');
    expect(after.ingredientPhotoVersions).toEqual(before.ingredientPhotoVersions);
    expect(after.inventories).toEqual(before.inventories);
  });

  test('replays confirmation without a second snapshot load or version pair', async () => {
    const { commands, nutrition, repository } = createHarness();
    const candidateId = await createRegisterAndRecognize(commands);
    const envelope = confirmationEnvelope(candidateId);

    const first = await commands.confirmIngredientCandidate('user-a', envelope);
    const replay = await commands.confirmIngredientCandidate('user-a', envelope);
    await expect(commands.confirmIngredientCandidate('user-a', confirmationEnvelope(
      candidateId,
      { confirmedGrams: 126 }
    ))).rejects.toMatchObject({ code: 'idempotency_key_reused' });

    expect(replay).toEqual(first);
    expect(vi.mocked(nutrition).getSnapshot.mock.calls).toHaveLength(2);
    const state = await repository.read('user-a');
    expect(state.ingredientPhotoVersions).toHaveLength(4);
    expect(state.inventories).toHaveLength(1);
    expect(state.idempotencyRecords.filter((record) => (
      record.operation === 'confirmIngredientCandidate'
    ))).toHaveLength(1);
  });
});
