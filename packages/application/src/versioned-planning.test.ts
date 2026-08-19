import { describe, expect, test, vi } from 'vitest';
import {
  TEST_DAILY_MENU_CATALOG,
  TEST_DAILY_MENU_TEMPLATES,
  TEST_NUTRITION_SNAPSHOTS,
  TEST_RECIPE_TEMPLATES
} from '@fitness/nutrition-fixtures';
import {
  ReviewedNutritionCache,
  StaticDailyMenuCatalogProvider,
  StaticRecipeTemplateProvider
} from '@fitness/providers';
import type { IngredientPhotoVersion, NutritionDataSnapshot } from '@fitness/domain';
import { deriveNextPhotoCleanupAt } from '@fitness/domain';
import { InMemoryPlanningRepository } from '@fitness/persistence';
import { createIngredientPhotoPlanningService } from './ingredient-photo';
import { createVersionedPlanningService } from './versioned-planning';

const BALANCED_SNAPSHOTS: readonly NutritionDataSnapshot[] = TEST_NUTRITION_SNAPSHOTS.map(
  (snapshot) => ({
    ...snapshot,
    nutrientsPer100g: {
      energyKcal: 160,
      proteinG: 5,
      fatG: 4.5,
      carbohydrateG: 24,
      fiberG: 2.2,
      saturatedFatG: 0.4,
      addedSugarG: 0
    }
  })
);

function photo(input: {
  readonly id: string;
  readonly photoId: string;
  readonly revision: number;
  readonly uploadCreatedAt: string;
  readonly workflowStatus?: IngredientPhotoVersion['workflowStatus'];
  readonly storageStatus?: IngredientPhotoVersion['storageStatus'];
  readonly candidates?: IngredientPhotoVersion['candidates'];
}): IngredientPhotoVersion {
  const uploadTime = Date.parse(input.uploadCreatedAt);
  const deleteDueAt = new Date(uploadTime + 23 * 60 * 60 * 1_000).toISOString();
  const deleted = input.storageStatus === 'deleted';
  return {
    kind: 'ingredient_photo_version',
    id: input.id,
    photoId: input.photoId,
    userId: 'user-a',
    revision: input.revision,
    createdAt: input.uploadCreatedAt,
    uploadCreatedAt: input.uploadCreatedAt,
    deleteDueAt,
    expectedCloudPath: `ingredient-photos/${input.photoId}/upload.jpg`,
    expectedPrivateFileId: `cloud://env.bucket/ingredient-photos/${input.photoId}/upload.jpg`,
    mediaType: 'image/jpeg',
    workflowStatus: input.workflowStatus ?? 'awaiting_upload',
    storageStatus: input.storageStatus ?? 'retained',
    candidates: input.candidates ?? [],
    confirmedCandidateId: null,
    confirmedGrams: null,
    inventoryVersionId: null,
    recognitionFailureCode: null,
    cleanupAttemptCount: 0,
    nextCleanupAt: deleted ? null : deleteDueAt,
    lastCleanupFailureCode: null,
    deletedAt: deleted ? '2026-08-19T02:00:00.000Z' : null
  };
}

describe('versioned planning ingredient photo context', () => {
  test('returns the most recently created logical photo after original storage deletion', async () => {
    const repository = new InMemoryPlanningRepository();
    const service = createVersionedPlanningService({
      repository,
      now: () => '2026-08-19T00:00:00.000Z',
      nextId: (prefix) => `${prefix}-unused`
    });
    const first = photo({
      id: 'photo-a-version-1',
      photoId: 'photo-a',
      revision: 1,
      uploadCreatedAt: '2026-08-19T00:00:00.000Z'
    });
    const secondAwaiting = photo({
      id: 'photo-b-version-1',
      photoId: 'photo-b',
      revision: 1,
      uploadCreatedAt: '2026-08-19T01:00:00.000Z'
    });
    const secondUploaded = {
      ...secondAwaiting,
      id: 'photo-b-version-2',
      revision: 2,
      workflowStatus: 'uploaded' as const
    };
    const candidates = [{
      id: 'candidate-b',
      foodId: 'food-b',
      nutritionSnapshotId: 'snapshot-b',
      canonicalNameZh: '食材B',
      confidence: 0.9,
      foodState: 'raw' as const
    }];
    const secondRecognized = {
      ...secondUploaded,
      id: 'photo-b-version-3',
      revision: 3,
      workflowStatus: 'recognized' as const,
      candidates
    };
    const secondDeleted = {
      ...secondRecognized,
      id: 'photo-b-version-4',
      revision: 4,
      storageStatus: 'deleted' as const,
      nextCleanupAt: null,
      deletedAt: '2026-08-19T02:00:00.000Z'
    };
    const versions = [secondAwaiting, secondUploaded, secondRecognized, secondDeleted, first];
    await repository.transact('user-a', (state) => ({
      nextState: {
        ...state,
        ingredientPhotoVersions: versions,
        nextPhotoCleanupAt: deriveNextPhotoCleanupAt(versions)
      },
      result: undefined
    }));

    const context = await service.getCurrentContext('user-a');

    expect(context.ingredientPhoto).toMatchObject({
      photoId: 'photo-b',
      revision: 4,
      workflowStatus: 'recognized',
      storageStatus: 'deleted',
      candidates
    });
    expect(context.latestVersions.ingredientPhoto).toBe(2);
  });

  test('breaks equal upload timestamps by logical photo ID independent of stored order', async () => {
    const repository = new InMemoryPlanningRepository();
    const service = createVersionedPlanningService({
      repository,
      now: () => '2026-08-19T00:00:00.000Z',
      nextId: (prefix) => `${prefix}-unused`
    });
    const photoB = photo({
      id: 'photo-b-version-1',
      photoId: 'photo-b',
      revision: 1,
      uploadCreatedAt: '2026-08-19T00:00:00.000Z'
    });
    const photoA = photo({
      id: 'photo-a-version-1',
      photoId: 'photo-a',
      revision: 1,
      uploadCreatedAt: '2026-08-19T00:00:00.000Z'
    });
    const versions = [photoB, photoA];
    await repository.transact('user-a', (state) => ({
      nextState: {
        ...state,
        ingredientPhotoVersions: versions,
        nextPhotoCleanupAt: deriveNextPhotoCleanupAt(versions)
      },
      result: undefined
    }));

    const context = await service.getCurrentContext('user-a');

    expect(context.ingredientPhoto?.photoId).toBe('photo-b');
    expect(context.latestVersions.ingredientPhoto).toBe(2);
  });

  test('derives an existing meal plan as stale after photo confirmation changes only inventory', async () => {
    const repository = new InMemoryPlanningRepository();
    const nutrition = new ReviewedNutritionCache({
      mode: 'test',
      snapshots: BALANCED_SNAPSHOTS
    });
    const chicken = BALANCED_SNAPSHOTS.find((snapshot) => snapshot.foodId === 'fixture-chicken');
    if (chicken === undefined) throw new Error('Expected chicken fixture');
    let sequence = 0;
    const service = createIngredientPhotoPlanningService({
      repository,
      nutrition,
      vision: {
        recognize: vi.fn(() => Promise.resolve({
          providerRequestId: 'vision-request-1',
          candidates: [{
            providerCandidateId: 'vision-candidate-1',
            name: chicken.canonicalNameZh,
            confidence: 0.94,
            foodState: chicken.foodState
          }]
        }))
      },
      storage: {
        inspectPrivateFile: vi.fn(() => Promise.resolve({
          mediaType: 'image/jpeg' as const,
          sizeBytes: 4
        })),
        deletePrivateFile: vi.fn(() => Promise.resolve('deleted' as const))
      },
      now: () => '2026-08-10T00:00:00.000Z',
      nextId: (prefix) => `${prefix}-${String(++sequence)}`,
      storageFileIdPrefix: 'cloud://env.bucket/',
      allowTestFixtures: true,
      providers: {
        nutrition,
        recipes: new StaticRecipeTemplateProvider({
          mode: 'test',
          templates: TEST_RECIPE_TEMPLATES
        }),
        menus: new StaticDailyMenuCatalogProvider({
          mode: 'test',
          catalog: TEST_DAILY_MENU_CATALOG,
          menus: TEST_DAILY_MENU_TEMPLATES
        }),
        allowTestFixtures: true
      }
    });
    await service.completePlanningSetup('user-a', {
      expectedVersions: { bodyProfile: 0, goal: 0, trainingPlan: 0 },
      idempotencyKey: 'planning-setup-001',
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
        goal: 'fat_loss',
        effectiveDate: '2026-08-10',
        targetDate: '2026-10-30'
      },
      trainingPlan: {
        weekStartDate: '2026-08-17',
        businessTimezone: 'Asia/Shanghai',
        sessions: []
      }
    });
    await service.saveInventory('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'inventory-save-001',
      payload: {
        items: BALANCED_SNAPSHOTS.map((snapshot) => ({
          name: snapshot.canonicalNameZh,
          availableGrams: 50_000
        }))
      }
    });
    const mealPlan = await service.generateWeeklyMealPlan('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'meal-generate-001',
      payload: { weekStartDate: '2026-08-17' }
    });
    const created = await service.createIngredientPhotoUpload('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'photo-create-001',
      payload: { mediaType: 'image/jpeg' }
    });
    const registered = await service.registerIngredientPhotoUpload('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'photo-register-001',
      payload: {
        photoId: created.photo.photoId,
        privateFileId: created.photo.expectedPrivateFileId
      }
    });
    const recognized = await service.recognizeIngredientPhoto('user-a', {
      expectedVersion: registered.photo.revision,
      idempotencyKey: 'photo-recognize-001',
      payload: { photoId: created.photo.photoId }
    });
    const candidate = recognized.photo.candidates[0];
    if (candidate === undefined) throw new Error('Expected recognized candidate');
    const before = await repository.read('user-a');

    await service.confirmIngredientCandidate('user-a', {
      expectedVersion: recognized.photo.revision,
      idempotencyKey: 'photo-confirm-001',
      payload: {
        photoId: created.photo.photoId,
        candidateId: candidate.id,
        confirmedGrams: 125,
        expectedInventoryVersion: 1
      }
    });

    const context = await service.getCurrentContext('user-a');
    const after = await repository.read('user-a');
    expect(context.mealPlan?.id).toBe(mealPlan.id);
    expect(context.mealPlanStale).toBe(true);
    expect(after.inventories).toHaveLength(before.inventories.length + 1);
    expect(after.mealPlans).toEqual(before.mealPlans);
    expect(after.dailyEnergyTargets).toEqual(before.dailyEnergyTargets);
    expect(after.dailyNutritionTargets).toEqual(before.dailyNutritionTargets);
    expect(after.recalculationJobs).toEqual(before.recalculationJobs);
    expect(after.outboxEvents).toEqual(before.outboxEvents);
  });
});
