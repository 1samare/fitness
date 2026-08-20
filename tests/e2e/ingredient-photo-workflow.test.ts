import { describe, expect, test } from 'vitest';
import {
  createIngredientPhotoCleanupService,
  createIngredientPhotoPlanningService,
  type PhotoCleanupTargetRepository
} from '../../packages/application/src/index';
import type { PlanningApiResponse } from '../../packages/contracts/src/index';
import {
  latestIngredientPhotoVersions,
  type IngredientPhotoVersion,
  type NutritionDataSnapshot,
  type PlanningAggregateState,
  type PrivatePhotoStorage,
  type VisionProvider
} from '../../packages/domain/src/index';
import {
  TEST_MEAL_PLANNING_DAILY_MENU_CATALOG,
  TEST_MEAL_PLANNING_DAILY_MENU_TEMPLATES,
  TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS,
  TEST_MEAL_PLANNING_RECIPE_TEMPLATES
} from '../../data/nutrition-fixtures/src/index';
import { InMemoryPlanningRepository } from '../../packages/persistence/src/index';
import {
  ReviewedNutritionCache,
  StaticDailyMenuCatalogProvider,
  StaticRecipeTemplateProvider
} from '../../packages/providers/src/index';
import { createPhotoCleanupHandler } from '../../cloudfunctions/photo-cleanup/src/handler';
import {
  createPlanningApiHandler,
  type TrustedRequestContext
} from '../../cloudfunctions/planning-api/src/handler';

const USER_A: TrustedRequestContext = { userId: 'user-a' };
const USER_B: TrustedRequestContext = { userId: 'user-b' };
const PHOTO_FILE_ID_PREFIX = 'cloud://ingredient-photo-e2e.bucket/';
const INITIAL_NOW = '2026-08-10T00:00:00.000Z';
const PHOTO_CREATED_AT = '2026-08-19T00:00:00.000Z';
const PHOTO_CONFIRMED_AT = '2026-08-19T01:00:00.000Z';
const ORPHAN_CREATED_AT = '2026-08-20T00:00:00.000Z';
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const PHOTO_SNAPSHOT_BASE = TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS[0];
if (PHOTO_SNAPSHOT_BASE === undefined) throw new Error('Expected a versioned nutrition fixture');

const PHOTO_SNAPSHOT: NutritionDataSnapshot = {
  ...PHOTO_SNAPSHOT_BASE,
  id: 'snapshot-reviewed-photo-pea-v1',
  foodId: 'reviewed-photo-pea',
  canonicalNameZh: '审核测试豌豆',
  sourceId: 'E2E-REVIEWED-PHOTO-FIXTURE',
  sourceRecordId: 'reviewed-photo-pea-record-v1',
  datasetVersion: 'reviewed-photo-e2e-2026-08-19',
  qualityStatus: 'reviewed'
};

type SuccessData = Extract<PlanningApiResponse, { readonly success: true }>['data'];

interface Harness {
  readonly handler: ReturnType<typeof createPlanningApiHandler>;
  readonly repository: InMemoryPlanningRepository;
  readonly storage: FakePrivatePhotoStorage;
  readonly vision: FakeVisionProvider;
  readonly cleanup: ReturnType<typeof createPhotoCleanupHandler>;
  readonly cleanupTargets: InMemoryPhotoCleanupTargets;
  readonly cleanupLogs: readonly unknown[];
  readonly setNow: (value: string) => void;
}

class FakePrivatePhotoStorage implements PrivatePhotoStorage {
  private readonly objects = new Map<string, Uint8Array>();
  public readonly inspections: string[] = [];
  public readonly deletions: { readonly privateFileId: string; readonly result: 'deleted' | 'not_found' }[] = [];

  public put(cloudPath: string, bytes: Uint8Array): void {
    this.objects.set(`${PHOTO_FILE_ID_PREFIX}${cloudPath}`, new Uint8Array(bytes));
  }

  public remove(privateFileId: string): void {
    this.objects.delete(privateFileId);
  }

  public has(privateFileId: string): boolean {
    return this.objects.has(privateFileId);
  }

  public inspectPrivateFile(input: { readonly privateFileId: string }) {
    this.inspections.push(input.privateFileId);
    const bytes = this.objects.get(input.privateFileId);
    if (bytes === undefined) return Promise.reject(new Error('controlled_missing_object'));
    return Promise.resolve({ mediaType: 'image/jpeg' as const, sizeBytes: bytes.byteLength });
  }

  public deletePrivateFile(
    input: { readonly privateFileId: string }
  ): Promise<'deleted' | 'not_found'> {
    const result = this.objects.delete(input.privateFileId) ? 'deleted' : 'not_found';
    this.deletions.push({ privateFileId: input.privateFileId, result });
    return Promise.resolve(result);
  }
}

class FakeVisionProvider implements VisionProvider {
  public readonly calls: { readonly privateFileId: string; readonly requestId: string }[] = [];

  public recognize(input: { readonly privateFileId: string; readonly requestId: string }) {
    this.calls.push(input);
    return Promise.resolve({
      providerRequestId: 'provider-internal-request-sentinel',
      candidates: [{
        providerCandidateId: 'provider-internal-candidate-sentinel',
        name: PHOTO_SNAPSHOT.canonicalNameZh,
        confidence: 0.96,
        foodState: PHOTO_SNAPSHOT.foodState
      }]
    });
  }
}

class InMemoryPhotoCleanupTargets implements PhotoCleanupTargetRepository {
  public readonly queries: { readonly before: string; readonly limit: number }[] = [];

  public constructor(
    private readonly repository: InMemoryPlanningRepository,
    private readonly trustedUserIds: readonly string[]
  ) {}

  public async listDueTargets(input: { readonly before: string; readonly limit: number }) {
    this.queries.push(input);
    const targets: { readonly userId: string; readonly photoId: string; readonly nextCleanupAt: string }[] = [];
    for (const userId of this.trustedUserIds) {
      const state = await this.repository.read(userId);
      for (const photo of latestIngredientPhotoVersions(state.ingredientPhotoVersions)) {
        if (
          photo.storageStatus !== 'deleted'
          && photo.nextCleanupAt !== null
          && photo.nextCleanupAt <= input.before
        ) targets.push({ userId, photoId: photo.photoId, nextCleanupAt: photo.nextCleanupAt });
      }
    }
    return targets
      .sort((left, right) => left.nextCleanupAt.localeCompare(right.nextCleanupAt)
        || left.userId.localeCompare(right.userId)
        || left.photoId.localeCompare(right.photoId))
      .slice(0, input.limit)
      .map(({ userId, photoId }) => ({ userId, photoId }));
  }
}

function createHarness(): Harness {
  const repository = new InMemoryPlanningRepository();
  const storage = new FakePrivatePhotoStorage();
  const vision = new FakeVisionProvider();
  const nutrition = new ReviewedNutritionCache({
    mode: 'test',
    snapshots: [...TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS, PHOTO_SNAPSHOT]
  });
  let sequence = 0;
  let instant = INITIAL_NOW;
  const nextId = (prefix: string) => `${prefix}-${String(++sequence)}`;
  const service = createIngredientPhotoPlanningService({
    repository,
    now: () => instant,
    nextId,
    providers: {
      nutrition,
      recipes: new StaticRecipeTemplateProvider({
        mode: 'test',
        templates: TEST_MEAL_PLANNING_RECIPE_TEMPLATES
      }),
      menus: new StaticDailyMenuCatalogProvider({
        mode: 'test',
        catalog: TEST_MEAL_PLANNING_DAILY_MENU_CATALOG,
        menus: TEST_MEAL_PLANNING_DAILY_MENU_TEMPLATES
      }),
      allowTestFixtures: true
    },
    nutrition,
    vision,
    storage,
    storageFileIdPrefix: PHOTO_FILE_ID_PREFIX,
    allowTestFixtures: true
  });
  const cleanupTargets = new InMemoryPhotoCleanupTargets(repository, [USER_A.userId, USER_B.userId]);
  const cleanupLogs: unknown[] = [];
  const cleanup = createPhotoCleanupHandler({
    targets: cleanupTargets,
    cleanup: createIngredientPhotoCleanupService({ repository, storage, nextId }),
    now: () => instant,
    nowMs: () => Date.parse(instant),
    logger: { info: (entry) => { cleanupLogs.push(entry); } }
  });
  return {
    handler: createPlanningApiHandler(service),
    repository,
    storage,
    vision,
    cleanup,
    cleanupTargets,
    cleanupLogs,
    setNow(value) {
      instant = value;
    }
  };
}

function requireData<K extends SuccessData['kind']>(
  response: PlanningApiResponse,
  kind: K
): Extract<SuccessData, { readonly kind: K }> {
  expect(response.success).toBe(true);
  if (!response.success || response.data.kind !== kind) {
    throw new Error(`Expected successful ${kind} response`);
  }
  return response.data as Extract<SuccessData, { readonly kind: K }>;
}

async function call(
  harness: Harness,
  context: TrustedRequestContext,
  request: unknown
): Promise<PlanningApiResponse> {
  const response = await harness.handler(request, context);
  const serialized = JSON.stringify(response);
  expect(serialized).not.toContain('userId');
  expect(serialized).not.toContain(context.userId);
  return response;
}

function setupRequest() {
  return {
    action: 'completePlanningSetup',
    payload: {
      expectedVersions: { bodyProfile: 0, goal: 0, trainingPlan: 0 },
      idempotencyKey: 'photo-e2e-setup-001',
      bodyProfile: {
        ageYears: 30,
        sexCode: 0,
        heightCm: 175,
        weightKg: 60,
        healthScopeConfirmed: true,
        nonTrainingActivity: 'light',
        allergens: [],
        avoidFoods: [],
        dietPreferences: [],
        businessTimezone: 'Asia/Shanghai'
      },
      goal: {
        goal: 'muscle_gain',
        effectiveDate: '2026-08-10',
        targetDate: '2026-10-30'
      },
      trainingPlan: {
        weekStartDate: '2026-08-17',
        businessTimezone: 'Asia/Shanghai',
        sessions: [{
          businessDate: '2026-08-19',
          sessionCode: '02054',
          durationMinutes: 60
        }]
      }
    }
  } as const;
}

function historicalPlanningFacts(state: PlanningAggregateState) {
  return structuredClone({
    bodyProfiles: state.bodyProfiles,
    goals: state.goals,
    trainingPlans: state.trainingPlans,
    dailyEnergyTargets: state.dailyEnergyTargets,
    dailyNutritionTargets: state.dailyNutritionTargets,
    mealPlans: state.mealPlans,
    mealPlanTargetDiffs: state.mealPlanTargetDiffs,
    mealPlanDecisions: state.mealPlanDecisions,
    trainingCompletionEvents: state.trainingCompletionEvents,
    recalculationJobs: state.recalculationJobs,
    outboxEvents: state.outboxEvents,
    activeBodyProfileVersionId: state.activeBodyProfileVersionId,
    activeGoalVersionId: state.activeGoalVersionId,
    activeTrainingPlanVersionId: state.activeTrainingPlanVersionId,
    activeMealPlanVersionId: state.activeMealPlanVersionId
  });
}

function latestPhoto(state: PlanningAggregateState, photoId: string): IngredientPhotoVersion {
  const photo = latestIngredientPhotoVersions(state.ingredientPhotoVersions)
    .find((candidate) => candidate.photoId === photoId);
  if (photo === undefined) throw new Error(`Missing latest photo ${photoId}`);
  return photo;
}

async function seedPlanningHistory(harness: Harness): Promise<PlanningAggregateState> {
  requireData(await call(harness, USER_A, setupRequest()), 'planning_setup_completed');
  requireData(await call(harness, USER_A, {
    action: 'saveInventory',
    payload: {
      expectedVersion: 0,
      idempotencyKey: 'photo-e2e-inventory-001',
      payload: {
        items: TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS.map((snapshot) => ({
          name: snapshot.canonicalNameZh,
          availableGrams: 50_000
        }))
      }
    }
  }), 'inventory_saved');
  requireData(await call(harness, USER_A, {
    action: 'generateWeeklyMealPlan',
    payload: {
      expectedVersion: 0,
      idempotencyKey: 'photo-e2e-meal-plan-001',
      payload: { weekStartDate: '2026-08-17' }
    }
  }), 'weekly_meal_plan_generated');
  const state = await harness.repository.read(USER_A.userId);
  expect(state.bodyProfiles).toHaveLength(1);
  expect(state.goals).toHaveLength(1);
  expect(state.trainingPlans).toHaveLength(1);
  expect(state.dailyEnergyTargets).toHaveLength(7);
  expect(state.dailyNutritionTargets).toHaveLength(7);
  expect(state.inventories).toHaveLength(1);
  expect(state.mealPlans).toHaveLength(1);
  return state;
}

describe('ingredient photo workflow end-to-end acceptance', () => {
  test('preserves planning history through authenticated recognition, explicit confirmation, response loss, isolation, and immediate NOT_FOUND cleanup', async () => {
    const harness = createHarness();
    const seeded = await seedPlanningHistory(harness);
    const historicalFacts = historicalPlanningFacts(seeded);
    const priorInventory = structuredClone(seeded.inventories);
    const userBBefore = await harness.repository.read(USER_B.userId);
    harness.setNow(PHOTO_CREATED_AT);

    const createRequest = {
      action: 'createIngredientPhotoUpload',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'photo-e2e-create-response-loss-001',
        payload: { mediaType: 'image/jpeg' }
      }
    } as const;
    await call(harness, USER_A, createRequest); // The caller loses this committed response.
    const created = requireData(
      await call(harness, USER_A, createRequest),
      'ingredient_photo_upload_created'
    );
    expect(created.photo).toMatchObject({ revision: 1, workflowStatus: 'awaiting_upload' });
    expect(created.cloudPath).toMatch(
      /^ingredient-photos\/ingredient-photo-\d+\/ingredient-photo-upload-\d+\.jpg$/
    );
    expect((await harness.repository.read(USER_A.userId)).ingredientPhotoVersions).toHaveLength(1);

    harness.storage.put(created.cloudPath, JPEG_BYTES);
    const privateFileId = `${PHOTO_FILE_ID_PREFIX}${created.cloudPath}`;
    const crossUserRegister = await call(harness, USER_B, {
      action: 'registerIngredientPhotoUpload',
      payload: {
        expectedVersion: 1,
        idempotencyKey: 'photo-e2e-cross-user-register-001',
        payload: { photoId: created.photo.photoId, privateFileId }
      }
    });
    expect(crossUserRegister).toMatchObject({
      success: false,
      error: { code: 'candidate_confirmation_required' }
    });
    expect(JSON.stringify(crossUserRegister)).not.toContain(privateFileId);

    const registerRequest = {
      action: 'registerIngredientPhotoUpload',
      payload: {
        expectedVersion: 1,
        idempotencyKey: 'photo-e2e-register-response-loss-001',
        payload: { photoId: created.photo.photoId, privateFileId }
      }
    } as const;
    await call(harness, USER_A, registerRequest); // Registration response is also safe to replay.
    const registered = requireData(
      await call(harness, USER_A, registerRequest),
      'ingredient_photo_upload_registered'
    );
    expect(registered.photo).toMatchObject({ revision: 2, workflowStatus: 'uploaded' });
    expect(harness.storage.inspections).toEqual([privateFileId]);

    const recognizeRequest = {
      action: 'recognizeIngredientPhoto',
      payload: {
        expectedVersion: 2,
        idempotencyKey: 'photo-e2e-recognize-001',
        payload: { photoId: created.photo.photoId }
      }
    } as const;
    const recognizedFirst = requireData(
      await call(harness, USER_A, recognizeRequest),
      'ingredient_photo_recognized'
    );
    const recognizedReplay = requireData(
      await call(harness, USER_A, recognizeRequest),
      'ingredient_photo_recognized'
    );
    expect(recognizedReplay).toEqual(recognizedFirst);
    expect(harness.vision.calls).toHaveLength(1);
    expect(recognizedFirst.photo.candidates).toEqual([{
      id: recognizedFirst.photo.candidates[0]?.id,
      foodId: PHOTO_SNAPSHOT.foodId,
      canonicalNameZh: PHOTO_SNAPSHOT.canonicalNameZh,
      confidence: 0.96,
      foodState: PHOTO_SNAPSHOT.foodState
    }]);
    const candidateId = recognizedFirst.photo.candidates[0]?.id;
    if (candidateId === undefined) throw new Error('Expected one reviewed public candidate');

    const publicContextBeforeConfirmation = requireData(
      await call(harness, USER_A, { action: 'getCurrentContext' }),
      'current_context'
    );
    expect(publicContextBeforeConfirmation.ingredientPhoto?.photoId).toBe(created.photo.photoId);
    const preConfirmationResponses = JSON.stringify([
      registered,
      recognizedFirst,
      recognizedReplay,
      publicContextBeforeConfirmation
    ]);
    expect(preConfirmationResponses).not.toMatch(/confirmedGrams|expectedPrivateFileId|expectedCloudPath/);
    expect(preConfirmationResponses).not.toContain('125');
    expect(preConfirmationResponses).not.toContain(privateFileId);
    expect(preConfirmationResponses).not.toContain('cloud://');
    expect(preConfirmationResponses).not.toContain('ingredient-photos/');
    expect(preConfirmationResponses).not.toContain('provider-internal-request-sentinel');
    expect(preConfirmationResponses).not.toContain('provider-internal-candidate-sentinel');

    const beforeConfirmation = await harness.repository.read(USER_A.userId);
    expect(historicalPlanningFacts(beforeConfirmation)).toEqual(historicalFacts);
    expect(beforeConfirmation.inventories).toEqual(priorInventory);
    expect(beforeConfirmation.ingredientPhotoVersions).toHaveLength(3);

    const crossUserConfirm = await call(harness, USER_B, {
      action: 'confirmIngredientCandidate',
      payload: {
        expectedVersion: 3,
        idempotencyKey: 'photo-e2e-cross-user-confirm-001',
        payload: {
          photoId: created.photo.photoId,
          candidateId,
          confirmedGrams: 125,
          expectedInventoryVersion: 1
        }
      }
    });
    expect(crossUserConfirm).toMatchObject({
      success: false,
      error: { code: 'candidate_confirmation_required' }
    });
    expect(await harness.repository.read(USER_B.userId)).toEqual(userBBefore);

    harness.setNow(PHOTO_CONFIRMED_AT);
    const confirmRequest = {
      action: 'confirmIngredientCandidate',
      payload: {
        expectedVersion: 3,
        idempotencyKey: 'photo-e2e-confirm-response-loss-001',
        payload: {
          photoId: created.photo.photoId,
          candidateId,
          confirmedGrams: 125,
          expectedInventoryVersion: 1
        }
      }
    } as const;
    const committedButLost = requireData(
      await call(harness, USER_A, confirmRequest),
      'ingredient_candidate_confirmed'
    );
    const confirmed = requireData(
      await call(harness, USER_A, confirmRequest),
      'ingredient_candidate_confirmed'
    );
    expect(confirmed).toEqual(committedButLost);
    expect(confirmed.photo).toMatchObject({
      revision: 4,
      workflowStatus: 'confirmed',
      confirmedCandidateId: candidateId
    });
    expect(confirmed.inventory.version).toBe(2);
    expect(confirmed.inventory.items.find((item) => item.foodId === PHOTO_SNAPSHOT.foodId)).toEqual({
      foodId: PHOTO_SNAPSHOT.foodId,
      nutritionSnapshotId: PHOTO_SNAPSHOT.id,
      availableGrams: 125
    });

    const afterConfirmation = await harness.repository.read(USER_A.userId);
    expect(historicalPlanningFacts(afterConfirmation)).toEqual(historicalFacts);
    expect(afterConfirmation.inventories).toHaveLength(priorInventory.length + 1);
    expect(afterConfirmation.inventories.slice(0, priorInventory.length)).toEqual(priorInventory);
    expect(afterConfirmation.ingredientPhotoVersions).toHaveLength(4);
    const confirmedPrivatePhoto = latestPhoto(afterConfirmation, created.photo.photoId);
    expect(confirmedPrivatePhoto).toMatchObject({
      revision: 4,
      inventoryVersionId: confirmed.inventory.id,
      confirmedGrams: 125,
      storageStatus: 'cleanup_pending',
      nextCleanupAt: PHOTO_CONFIRMED_AT
    });
    expect(confirmedPrivatePhoto.deleteDueAt).toBe('2026-08-19T23:00:00.000Z');
    expect(confirmedPrivatePhoto.nextCleanupAt).not.toBe(confirmedPrivatePhoto.deleteDueAt);
    expect(afterConfirmation.nextPhotoCleanupAt).toBe(PHOTO_CONFIRMED_AT);

    const contextAfterConfirmation = requireData(
      await call(harness, USER_A, { action: 'getCurrentContext' }),
      'current_context'
    );
    expect(contextAfterConfirmation.mealPlan?.id).toBe(seeded.activeMealPlanVersionId);
    expect(contextAfterConfirmation.mealPlanStale).toBe(true);

    harness.storage.remove(privateFileId);
    const cleanupSummary = await harness.cleanup();
    expect(cleanupSummary).toEqual({
      processed: 1,
      deleted: 1,
      retryScheduled: 0,
      skipped: 0,
      failed: 0
    });
    expect(harness.cleanupTargets.queries.at(-1)).toEqual({ before: PHOTO_CONFIRMED_AT, limit: 50 });
    expect(harness.storage.deletions.at(-1)).toEqual({ privateFileId, result: 'not_found' });
    const afterCleanup = await harness.repository.read(USER_A.userId);
    expect(latestPhoto(afterCleanup, created.photo.photoId)).toMatchObject({
      revision: 5,
      storageStatus: 'deleted',
      nextCleanupAt: null,
      deletedAt: PHOTO_CONFIRMED_AT
    });
    expect(historicalPlanningFacts(afterCleanup)).toEqual(historicalFacts);
    expect(afterCleanup.inventories).toEqual(afterConfirmation.inventories);

    const publicAfterCreate = JSON.stringify([
      registered,
      recognizedFirst,
      crossUserRegister,
      crossUserConfirm,
      confirmed,
      contextAfterConfirmation
    ]);
    for (const forbidden of [
      USER_A.userId,
      USER_B.userId,
      privateFileId,
      PHOTO_FILE_ID_PREFIX,
      created.cloudPath,
      'provider-internal-request-sentinel',
      'provider-internal-candidate-sentinel',
      'controlled_missing_object',
      JSON.stringify([...JPEG_BYTES]),
      'prompt'
    ]) expect(publicAfterCreate).not.toContain(forbidden);
    expect(JSON.stringify(harness.cleanupLogs)).not.toMatch(
      /user-a|user-b|cloud:\/\/|ingredient-photos|provider-internal|审核测试豌豆|controlled_missing_object/
    );
  });

  test('deletes an unregistered orphan at the persisted +23h target and remains idempotent', async () => {
    const harness = createHarness();
    harness.setNow(ORPHAN_CREATED_AT);
    const created = requireData(await call(harness, USER_A, {
      action: 'createIngredientPhotoUpload',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'photo-e2e-orphan-create-001',
        payload: { mediaType: 'image/jpeg' }
      }
    }), 'ingredient_photo_upload_created');
    harness.storage.put(created.cloudPath, JPEG_BYTES);
    const privateFileId = `${PHOTO_FILE_ID_PREFIX}${created.cloudPath}`;
    const stateBeforeDue = await harness.repository.read(USER_A.userId);
    const orphan = latestPhoto(stateBeforeDue, created.photo.photoId);
    expect(orphan).toMatchObject({
      revision: 1,
      workflowStatus: 'awaiting_upload',
      deleteDueAt: '2026-08-20T23:00:00.000Z',
      nextCleanupAt: '2026-08-20T23:00:00.000Z'
    });
    expect(orphan.expectedPrivateFileId).toBe(privateFileId);
    expect(harness.storage.has(privateFileId)).toBe(true);

    harness.setNow('2026-08-20T22:59:59.999Z');
    expect(await harness.cleanup()).toEqual({
      processed: 0,
      deleted: 0,
      retryScheduled: 0,
      skipped: 0,
      failed: 0
    });
    expect(harness.storage.has(privateFileId)).toBe(true);

    harness.setNow(orphan.deleteDueAt);
    expect(await harness.cleanup()).toEqual({
      processed: 1,
      deleted: 1,
      retryScheduled: 0,
      skipped: 0,
      failed: 0
    });
    expect(harness.storage.deletions.at(-1)).toEqual({ privateFileId, result: 'deleted' });
    expect(harness.storage.has(privateFileId)).toBe(false);
    const deletedState = await harness.repository.read(USER_A.userId);
    expect(latestPhoto(deletedState, created.photo.photoId)).toMatchObject({
      revision: 2,
      workflowStatus: 'awaiting_upload',
      storageStatus: 'deleted',
      deletedAt: orphan.deleteDueAt
    });

    expect(await harness.cleanup()).toEqual({
      processed: 0,
      deleted: 0,
      retryScheduled: 0,
      skipped: 0,
      failed: 0
    });
    expect(harness.storage.deletions).toHaveLength(1);
  });
});
