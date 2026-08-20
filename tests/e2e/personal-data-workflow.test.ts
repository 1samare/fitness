import type { AssistantLanguageModelProvider } from '../../packages/agent/src/index';
import {
  StorageUnavailableError,
  createAccountDeletionGuardedRepository,
  createMealPlanRecalculationService,
  createPersonalDataService
} from '../../packages/application/src/index';
import type {
  PlanningApiRequest,
  PlanningApiResponse
} from '../../packages/contracts/src/index';
import {
  deriveNextPhotoCleanupAt,
  type IngredientPhotoVersion,
  type NutrientValues,
  type PrivatePhotoStorage
} from '../../packages/domain/src/index';
import { REVIEWED_MET_DATASET } from '../../data/met-sessions/src/index';
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
import { describe, expect, test, vi } from 'vitest';
import { createAssistantApiComposition } from '../../cloudfunctions/assistant-api/src/handler';
import { createPlanningApiHandler } from '../../cloudfunctions/planning-api/src/handler';

const NOW = '2026-08-20T00:00:00.000Z';
const WEEK_START = '2026-08-24';
const TRAINING_DATE = '2026-08-26';
const PHOTO_FILE_ID = 'cloud://test-env.bucket/ingredient-photos/user-a/photo-1.jpg';

function fixtureProviders() {
  return {
    nutrition: new ReviewedNutritionCache({
      mode: 'test', snapshots: TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS
    }),
    recipes: new StaticRecipeTemplateProvider({
      mode: 'test', templates: TEST_MEAL_PLANNING_RECIPE_TEMPLATES
    }),
    menus: new StaticDailyMenuCatalogProvider({
      mode: 'test',
      catalog: TEST_MEAL_PLANNING_DAILY_MENU_CATALOG,
      menus: TEST_MEAL_PLANNING_DAILY_MENU_TEMPLATES
    }),
    allowTestFixtures: true
  } as const;
}

function roundHalfUp(value: number, decimalPlaces: number): number {
  const factor = 10 ** decimalPlaces;
  const scaled = value * factor;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 2;
  return Math.floor(scaled + 0.5 + tolerance) / factor;
}

function zeroNutrients(): NutrientValues {
  return {
    energyKcal: 0,
    proteinG: 0,
    fatG: 0,
    carbohydrateG: 0,
    fiberG: 0,
    saturatedFatG: 0,
    addedSugarG: 0
  };
}

function addScaledNutrients(
  totals: NutrientValues,
  nutrients: NutrientValues,
  grams: number
): NutrientValues {
  const factor = grams / 100;
  return {
    energyKcal: totals.energyKcal + roundHalfUp(nutrients.energyKcal * factor, 1),
    proteinG: totals.proteinG + roundHalfUp(nutrients.proteinG * factor, 1),
    fatG: totals.fatG + roundHalfUp(nutrients.fatG * factor, 1),
    carbohydrateG: totals.carbohydrateG + roundHalfUp(nutrients.carbohydrateG * factor, 1),
    fiberG: totals.fiberG + roundHalfUp(nutrients.fiberG * factor, 1),
    saturatedFatG: totals.saturatedFatG + roundHalfUp(nutrients.saturatedFatG * factor, 1),
    addedSugarG: totals.addedSugarG + roundHalfUp(nutrients.addedSugarG * factor, 1)
  };
}

function roundNutrients(value: NutrientValues): NutrientValues {
  return {
    energyKcal: roundHalfUp(value.energyKcal, 1),
    proteinG: roundHalfUp(value.proteinG, 1),
    fatG: roundHalfUp(value.fatG, 1),
    carbohydrateG: roundHalfUp(value.carbohydrateG, 1),
    fiberG: roundHalfUp(value.fiberG, 1),
    saturatedFatG: roundHalfUp(value.saturatedFatG, 1),
    addedSugarG: roundHalfUp(value.addedSugarG, 1)
  };
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Expected string JSON field ${field}`);
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Expected number JSON field ${field}`);
  }
  return value;
}

interface ExportedTrainingSession {
  readonly businessDate: string;
  readonly reviewedSessionCode: string;
  readonly durationMinutes: number;
}

function parseTrainingSessions(value: unknown): readonly ExportedTrainingSession[] {
  if (!Array.isArray(value)) throw new Error('Expected exported training sessions');
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error('Expected exported training session object');
    return {
      businessDate: requiredString(entry.businessDate, 'businessDate'),
      reviewedSessionCode: requiredString(entry.reviewedSessionCode, 'reviewedSessionCode'),
      durationMinutes: requiredNumber(entry.durationMinutes, 'durationMinutes')
    };
  });
}

interface ExportedIngredient {
  readonly displayNameZh: string;
  readonly grams: number;
}

interface ExportedMealDay {
  readonly businessDate: string;
  readonly meals: readonly { readonly ingredients: readonly ExportedIngredient[] }[];
  readonly nutritionTotals: NutrientValues;
}

function parseNutrients(value: unknown): NutrientValues {
  if (!isRecord(value)) throw new Error('Expected exported nutrient totals');
  return {
    energyKcal: requiredNumber(value.energyKcal, 'energyKcal'),
    proteinG: requiredNumber(value.proteinG, 'proteinG'),
    fatG: requiredNumber(value.fatG, 'fatG'),
    carbohydrateG: requiredNumber(value.carbohydrateG, 'carbohydrateG'),
    fiberG: requiredNumber(value.fiberG, 'fiberG'),
    saturatedFatG: requiredNumber(value.saturatedFatG, 'saturatedFatG'),
    addedSugarG: requiredNumber(value.addedSugarG, 'addedSugarG')
  };
}

function parseMealDays(value: unknown): readonly ExportedMealDay[] {
  if (!Array.isArray(value)) throw new Error('Expected exported meal days');
  return value.map((day) => {
    if (!isRecord(day) || !Array.isArray(day.meals)) {
      throw new Error('Expected exported meal day object');
    }
    return {
      businessDate: requiredString(day.businessDate, 'businessDate'),
      meals: day.meals.map((meal) => {
        if (!isRecord(meal) || !Array.isArray(meal.ingredients)) {
          throw new Error('Expected exported meal object');
        }
        return {
          ingredients: meal.ingredients.map((ingredient) => {
            if (!isRecord(ingredient)) throw new Error('Expected exported ingredient object');
            return {
              displayNameZh: requiredString(ingredient.displayNameZh, 'displayNameZh'),
              grams: requiredNumber(ingredient.grams, 'grams')
            };
          })
        };
      }),
      nutritionTotals: parseNutrients(day.nutritionTotals)
    };
  });
}

interface ExportedInventoryItem {
  readonly foodNameZh: string;
  readonly availableGrams: number;
  readonly reviewedSourceVersionReference: string;
}

function parseInventoryItems(value: unknown): readonly ExportedInventoryItem[] {
  if (!Array.isArray(value)) throw new Error('Expected exported inventory items');
  return value.map((item) => {
    if (!isRecord(item)) throw new Error('Expected exported inventory item object');
    return {
      foodNameZh: requiredString(item.foodNameZh, 'foodNameZh'),
      availableGrams: requiredNumber(item.availableGrams, 'availableGrams'),
      reviewedSourceVersionReference: requiredString(
        item.reviewedSourceVersionReference,
        'reviewedSourceVersionReference'
      )
    };
  });
}

interface ExportedCandidate {
  readonly canonicalNameZh: string;
  readonly confidence: number;
  readonly foodState: string;
}

function parseCandidates(value: unknown): readonly ExportedCandidate[] {
  if (!Array.isArray(value)) throw new Error('Expected exported photo candidates');
  return value.map((candidate) => {
    if (!isRecord(candidate)) throw new Error('Expected exported photo candidate object');
    return {
      canonicalNameZh: requiredString(candidate.canonicalNameZh, 'canonicalNameZh'),
      confidence: requiredNumber(candidate.confidence, 'confidence'),
      foodState: requiredString(candidate.foodState, 'foodState')
    };
  });
}

type ExportData = Readonly<Record<string, string | number | boolean | null | string[]>>;

function numberField(data: ExportData, key: string): number {
  const value = data[key];
  if (typeof value !== 'number') throw new Error(`Expected numeric export field ${key}`);
  return value;
}

function stringField(data: ExportData, key: string): string {
  const value = data[key];
  if (typeof value !== 'string') throw new Error(`Expected string export field ${key}`);
  return value;
}

async function callPlanning(
  handler: ReturnType<typeof createPlanningApiHandler>,
  userId: string,
  request: PlanningApiRequest
): Promise<PlanningApiResponse> {
  return handler(request, { userId });
}

async function preparePlanningHistory(
  handler: ReturnType<typeof createPlanningApiHandler>,
  userId: string,
  suffix: string
): Promise<void> {
  await expect(callPlanning(handler, userId, {
    action: 'completePlanningSetup',
    payload: {
      expectedVersions: { bodyProfile: 0, goal: 0, trainingPlan: 0 },
      idempotencyKey: `personal-setup-${suffix}-0001`,
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
        effectiveDate: '2026-08-20',
        targetDate: '2026-10-30'
      },
      trainingPlan: {
        weekStartDate: WEEK_START,
        businessTimezone: 'Asia/Shanghai',
        sessions: [{
          businessDate: TRAINING_DATE,
          sessionCode: '02054',
          durationMinutes: 60
        }]
      }
    }
  })).resolves.toMatchObject({ success: true, data: { kind: 'planning_setup_completed' } });
  await expect(callPlanning(handler, userId, {
    action: 'saveInventory',
    payload: {
      expectedVersion: 0,
      idempotencyKey: `personal-inventory-${suffix}-0001`,
      payload: {
        items: TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS.map((snapshot) => ({
          name: snapshot.canonicalNameZh,
          availableGrams: 50_000
        }))
      }
    }
  })).resolves.toMatchObject({ success: true, data: { kind: 'inventory_saved' } });
  await expect(callPlanning(handler, userId, {
    action: 'generateWeeklyMealPlan',
    payload: {
      expectedVersion: 0,
      idempotencyKey: `personal-meal-${suffix}-0001`,
      payload: { weekStartDate: WEEK_START }
    }
  })).resolves.toMatchObject({
    success: true,
    data: { kind: 'weekly_meal_plan_generated' }
  });
}

function photoVersions(
  userId: string,
  inventoryVersionId: string,
  foodId: string,
  nutritionSnapshotId: string
): readonly IngredientPhotoVersion[] {
  const snapshot = TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS.find(
    (candidate) => candidate.id === nutritionSnapshotId
  );
  if (snapshot === undefined) throw new Error('Expected reviewed nutrition fixture');
  const candidate = {
    id: 'photo-candidate-user-a-1',
    foodId,
    nutritionSnapshotId,
    canonicalNameZh: snapshot.canonicalNameZh,
    confidence: 0.97,
    foodState: snapshot.foodState
  };
  const awaiting: IngredientPhotoVersion = {
    kind: 'ingredient_photo_version',
    id: 'photo-version-user-a-1',
    photoId: 'photo-user-a-1',
    userId,
    revision: 1,
    createdAt: NOW,
    uploadCreatedAt: NOW,
    deleteDueAt: '2026-08-20T23:00:00.000Z',
    expectedCloudPath: 'ingredient-photos/user-a/photo-1.jpg',
    expectedPrivateFileId: PHOTO_FILE_ID,
    mediaType: 'image/jpeg',
    workflowStatus: 'awaiting_upload',
    storageStatus: 'retained',
    candidates: [],
    confirmedCandidateId: null,
    confirmedGrams: null,
    inventoryVersionId: null,
    recognitionFailureCode: null,
    cleanupAttemptCount: 0,
    nextCleanupAt: '2026-08-20T23:00:00.000Z',
    lastCleanupFailureCode: null,
    deletedAt: null
  };
  const uploaded: IngredientPhotoVersion = {
    ...awaiting,
    id: 'photo-version-user-a-2',
    revision: 2,
    createdAt: '2026-08-20T00:01:00.000Z',
    workflowStatus: 'uploaded'
  };
  const recognized: IngredientPhotoVersion = {
    ...uploaded,
    id: 'photo-version-user-a-3',
    revision: 3,
    createdAt: '2026-08-20T00:02:00.000Z',
    workflowStatus: 'recognized',
    candidates: [candidate]
  };
  return [awaiting, uploaded, recognized, {
    ...recognized,
    id: 'photo-version-user-a-4',
    revision: 4,
    createdAt: '2026-08-20T00:03:00.000Z',
    workflowStatus: 'confirmed',
    confirmedCandidateId: candidate.id,
    confirmedGrams: 125,
    inventoryVersionId
  }];
}

async function addConfirmedPhoto(
  repository: InMemoryPlanningRepository,
  userId: string
): Promise<void> {
  await repository.transact(userId, (state) => {
    const activeInventory = state.inventories.find(
      (inventory) => inventory.id === state.activeInventoryVersionId
    );
    const firstItem = activeInventory?.items[0];
    if (activeInventory === undefined || firstItem === undefined) {
      throw new Error('Expected active inventory for confirmed photo');
    }
    const inventory = {
      ...activeInventory,
      id: 'inventory-user-a-photo-confirmed',
      version: activeInventory.version + 1,
      createdAt: '2026-08-20T00:03:00.000Z',
      items: activeInventory.items.map((item) => ({
        ...item,
        availableGrams: item.foodId === firstItem.foodId
          && item.nutritionSnapshotId === firstItem.nutritionSnapshotId
          ? item.availableGrams + 125
          : item.availableGrams
      }))
    };
    const photos = photoVersions(
      userId,
      inventory.id,
      firstItem.foodId,
      firstItem.nutritionSnapshotId
    );
    return {
      nextState: {
        ...state,
        inventories: [...state.inventories, inventory],
        activeInventoryVersionId: inventory.id,
        ingredientPhotoVersions: photos,
        nextPhotoCleanupAt: deriveNextPhotoCleanupAt(photos)
      },
      result: undefined
    };
  });
}

function assertExportedNumbersAreReproducible(
  exported: Extract<PlanningApiResponse, { success: true }>['data']
): void {
  if (exported.kind !== 'personal_data_export') throw new Error('Expected personal data export');
  const records = exported.records;
  const profile = records.find((record) => record.category === 'body_profile');
  expect(profile?.data).toMatchObject({
    ageYears: 30,
    heightCm: 175,
    weightKg: 60,
    healthScopeConfirmed: true
  });

  const training = records.find((record) => record.category === 'training_plan');
  if (training === undefined) throw new Error('Expected exported training plan');
  const sessions = parseTrainingSessions(parseJson(stringField(training.data, 'sessionsJson')));
  expect(sessions).toEqual([{
    businessDate: TRAINING_DATE,
    reviewedSessionCode: '02054',
    durationMinutes: 60
  }]);
  const reviewedSession = REVIEWED_MET_DATASET.sessions.find((session) => session.code === '02054');
  if (reviewedSession === undefined) throw new Error('Expected reviewed MET session');

  const bmr = 14.52 * 60 + 565.79;
  const baseline = bmr * 1.5;
  const energyRecords = records.filter((record) => record.category === 'daily_energy_target');
  expect(energyRecords).toHaveLength(7);
  const targetEnergyByDate = new Map<string, number>();
  for (const record of energyRecords) {
    const businessDate = stringField(record.data, 'businessDate');
    const session = sessions.find((value) => value.businessDate === businessDate);
    const trainingNet = session === undefined
      ? 0
      : (reviewedSession.met - 1) * 3.5 * 60 / 200 * session.durationMinutes;
    const maintenance = baseline + trainingNet;
    const targetEnergy = roundHalfUp(maintenance * 1.05, 0);
    targetEnergyByDate.set(businessDate, targetEnergy);
    expect(numberField(record.data, 'bmiEstimate')).toBe(roundHalfUp(60 / 1.75 ** 2, 2));
    expect(numberField(record.data, 'estimatedBmrKcal')).toBe(roundHalfUp(bmr, 0));
    expect(numberField(record.data, 'estimatedNonTrainingBaselineKcal'))
      .toBe(roundHalfUp(baseline, 0));
    expect(numberField(record.data, 'estimatedTrainingNetKcal'))
      .toBe(roundHalfUp(trainingNet, 0));
    expect(numberField(record.data, 'estimatedMaintenanceKcal'))
      .toBe(roundHalfUp(maintenance, 0));
    expect(numberField(record.data, 'estimatedTargetEnergyKcal')).toBe(targetEnergy);
  }

  const nutritionRecords = records.filter(
    (record) => record.category === 'daily_nutrition_target'
  );
  expect(nutritionRecords).toHaveLength(7);
  for (const record of nutritionRecords) {
    const businessDate = stringField(record.data, 'businessDate');
    const targetEnergy = targetEnergyByDate.get(businessDate);
    if (targetEnergy === undefined) throw new Error('Expected matching energy export');
    const proteinG = roundHalfUp(60 * 1.6, 1);
    const proteinKcal = proteinG * 4;
    const fatKcal = targetEnergy * 0.25;
    const carbohydrateKcal = targetEnergy - proteinKcal - fatKcal;
    expect(numberField(record.data, 'estimatedTargetEnergyKcal')).toBe(targetEnergy);
    expect(numberField(record.data, 'estimatedProteinG')).toBe(proteinG);
    expect(numberField(record.data, 'estimatedFatG')).toBe(roundHalfUp(fatKcal / 9, 1));
    expect(numberField(record.data, 'estimatedCarbohydrateG'))
      .toBe(roundHalfUp(carbohydrateKcal / 4, 1));
    expect(numberField(record.data, 'estimatedProteinEnergyPercent'))
      .toBe(roundHalfUp(proteinKcal / targetEnergy * 100, 1));
    expect(numberField(record.data, 'estimatedFatEnergyPercent')).toBe(25);
    expect(numberField(record.data, 'estimatedCarbohydrateEnergyPercent'))
      .toBe(roundHalfUp(carbohydrateKcal / targetEnergy * 100, 1));
    expect(numberField(record.data, 'estimatedFiberMinimumG')).toBe(25);
    expect(numberField(record.data, 'estimatedFiberMaximumG')).toBe(30);
    expect(numberField(record.data, 'estimatedSaturatedFatMaximumExclusiveG'))
      .toBe((Math.ceil(targetEnergy * 0.1 / 9 * 10) - 1) / 10);
    expect(numberField(record.data, 'estimatedAddedSugarMaximumExclusiveG'))
      .toBe((Math.ceil(targetEnergy * 0.1 / 4 * 10) - 1) / 10);
  }

  const inventoryRecords = records.filter((record) => record.category === 'inventory');
  expect(inventoryRecords).toHaveLength(2);
  for (const record of inventoryRecords) {
    const items = parseInventoryItems(
      parseJson(stringField(record.data, 'itemsJson'))
    );
    expect(items).toHaveLength(TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS.length);
    const increased = items.filter((item) => item.availableGrams === 50_125);
    expect(increased).toHaveLength(record.recordVersion === 2 ? 1 : 0);
    expect(items.every((item) => item.availableGrams === 50_000 || item.availableGrams === 50_125))
      .toBe(true);
  }

  const snapshotsByName = new Map(
    TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS.map((snapshot) => [
      snapshot.canonicalNameZh,
      snapshot
    ])
  );
  const mealRecords = records.filter((record) => record.category === 'meal_plan');
  expect(mealRecords).toHaveLength(1);
  for (const record of mealRecords) {
    const days = parseMealDays(parseJson(stringField(record.data, 'daysJson')));
    expect(days).toHaveLength(7);
    for (const day of days) {
      const gramsByName = new Map<string, number>();
      for (const meal of day.meals) {
        for (const ingredient of meal.ingredients) {
          gramsByName.set(
            ingredient.displayNameZh,
            roundHalfUp((gramsByName.get(ingredient.displayNameZh) ?? 0) + ingredient.grams, 1)
          );
        }
      }
      let totals = zeroNutrients();
      for (const [name, grams] of gramsByName) {
        const snapshot = snapshotsByName.get(name);
        if (snapshot === undefined) throw new Error(`Missing reviewed snapshot for ${name}`);
        totals = addScaledNutrients(totals, snapshot.nutrientsPer100g, grams);
      }
      expect(day.nutritionTotals).toEqual(roundNutrients(totals));
    }
  }

  const photo = records.find((record) => record.category === 'ingredient_photo_confirmation');
  if (photo === undefined) throw new Error('Expected photo confirmation export');
  const candidates = parseCandidates(
    parseJson(stringField(photo.data, 'candidatesJson'))
  );
  expect(candidates).toEqual([expect.objectContaining({ confidence: 0.97 })]);
  expect(numberField(photo.data, 'confirmedGrams')).toBe(125);

  const assistantRecords = records.filter((record) => record.category === 'assistant_message');
  expect(assistantRecords).toHaveLength(2);
  expect(assistantRecords.map((record) => record.contentOrigin).sort())
    .toEqual(['ai_assisted', 'user']);
}

describe('personal data API workflow', () => {
  test('exports reproducible history and deletes only one authenticated identity with retry safety', async () => {
    const rawRepository = new InMemoryPlanningRepository();
    const repository = createAccountDeletionGuardedRepository(rawRepository);
    let sequence = 0;
    const nextId = (prefix: string): string => `${prefix}-personal-e2e-${String(++sequence)}`;
    const planning = createMealPlanRecalculationService({
      repository,
      providers: fixtureProviders(),
      now: () => NOW,
      nextId
    });
    let deleteAttempt = 0;
    const storage: PrivatePhotoStorage = {
      inspectPrivateFile: () => Promise.reject(new Error('unused')),
      deletePrivateFile: vi.fn(() => {
        deleteAttempt += 1;
        return deleteAttempt === 1
          ? Promise.reject(new StorageUnavailableError())
          : Promise.resolve('deleted' as const);
      })
    };
    const personalData = createPersonalDataService({
      repository: rawRepository,
      storage,
      now: () => NOW
    });
    const planningHandler = createPlanningApiHandler(Object.assign(planning, personalData));
    const generateIntent = vi.fn<AssistantLanguageModelProvider['generateIntent']>(() => (
      Promise.resolve({
        rawText: JSON.stringify({ kind: 'reject', reason: 'unsupported_request' })
      })
    ));
    const assistantHandler = createAssistantApiComposition({
      repository,
      planning,
      provider: { generateIntent },
      now: () => NOW,
      nextId
    });
    const userA = 'personal-data-e2e-user-a';
    const userB = 'personal-data-e2e-user-b';

    await preparePlanningHistory(planningHandler, userA, 'user-a');
    await preparePlanningHistory(planningHandler, userB, 'user-b');
    await addConfirmedPhoto(rawRepository, userA);
    await expect(assistantHandler({
      action: 'sendAssistantMessage',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'personal-assistant-user-a-0001',
        message: '请替我诊断并开药'
      }
    }, { userId: userA })).resolves.toMatchObject({
      success: true,
      data: { kind: 'assistant_turn_completed' }
    });

    const stateBBefore = await rawRepository.readExisting(userB);
    if (stateBBefore === null) throw new Error('Expected user B state');
    const stateBBytes = JSON.stringify(stateBBefore);
    const summaryA = await callPlanning(planningHandler, userA, {
      action: 'getPersonalDataSummary'
    });
    const summaryB = await callPlanning(planningHandler, userB, {
      action: 'getPersonalDataSummary'
    });
    if (
      !summaryA.success
      || summaryA.data.kind !== 'personal_data_summary'
      || summaryA.data.snapshotToken === null
      || !summaryB.success
      || summaryB.data.kind !== 'personal_data_summary'
      || summaryB.data.snapshotToken === null
    ) throw new Error('Expected isolated personal-data summaries');

    const exportedA = await callPlanning(planningHandler, userA, {
      action: 'exportPersonalData',
      snapshotToken: summaryA.data.snapshotToken
    });
    if (!exportedA.success) throw new Error('Expected user A export');
    assertExportedNumbersAreReproducible(exportedA.data);
    expect(JSON.stringify(exportedA)).not.toMatch(
      /personal-data-e2e-user-a|expectedPrivateFileId|requestFingerprint|idempotencyRecords|accountDeletion/
    );
    await expect(callPlanning(planningHandler, userB, {
      action: 'exportPersonalData',
      snapshotToken: summaryA.data.snapshotToken
    })).resolves.toMatchObject({
      success: false,
      error: { code: 'personal_data_snapshot_conflict' }
    });

    const deleteCommand = {
      action: 'deleteAccount',
      payload: {
        snapshotToken: summaryA.data.snapshotToken,
        idempotencyKey: 'delete-account-personal-e2e-0001',
        confirmation: 'DELETE_MY_ACCOUNT'
      }
    } as const;
    await expect(callPlanning(planningHandler, userA, deleteCommand)).resolves.toMatchObject({
      success: false,
      error: { code: 'storage_unavailable' }
    });

    const modelCallsBeforeBlockedRequest = generateIntent.mock.calls.length;
    await expect(callPlanning(planningHandler, userA, { action: 'getCurrentContext' }))
      .resolves.toMatchObject({
        success: false,
        error: { code: 'account_deletion_pending' }
      });
    await expect(callPlanning(planningHandler, userA, {
      action: 'saveBodyProfile',
      payload: {
        expectedVersion: 1,
        idempotencyKey: 'blocked-profile-user-a-0001',
        payload: {
          ageYears: 31,
          sexCode: 0,
          heightCm: 175,
          weightKg: 60,
          healthScopeConfirmed: true,
          nonTrainingActivity: 'light',
          allergens: [],
          avoidFoods: [],
          dietPreferences: [],
          businessTimezone: 'Asia/Shanghai'
        }
      }
    })).resolves.toMatchObject({
      success: false,
      error: { code: 'account_deletion_pending' }
    });
    await expect(assistantHandler({ action: 'getAssistantConversation' }, { userId: userA }))
      .resolves.toMatchObject({
        success: false,
        error: { code: 'account_deletion_pending' }
      });
    await expect(assistantHandler({
      action: 'sendAssistantMessage',
      payload: {
        expectedVersion: 1,
        idempotencyKey: 'blocked-assistant-user-a-0001',
        message: '把 2026-08-26 的训练移到 2026-08-27'
      }
    }, { userId: userA })).resolves.toMatchObject({
      success: false,
      error: { code: 'account_deletion_pending' }
    });
    expect(generateIntent).toHaveBeenCalledTimes(modelCallsBeforeBlockedRequest);

    await expect(callPlanning(planningHandler, userA, deleteCommand)).resolves.toMatchObject({
      success: true,
      data: { kind: 'account_deleted', deletedPrivateFileCount: 1 }
    });
    await expect(rawRepository.readExisting(userA)).resolves.toBeNull();
    expect(JSON.stringify(await rawRepository.readExisting(userB))).toBe(stateBBytes);
    await expect(callPlanning(planningHandler, userB, {
      action: 'exportPersonalData',
      snapshotToken: summaryB.data.snapshotToken
    })).resolves.toMatchObject({
      success: true,
      data: { kind: 'personal_data_export', snapshotToken: summaryB.data.snapshotToken }
    });

    await preparePlanningHistory(planningHandler, userA, 'user-a-recreated');
    await expect(callPlanning(planningHandler, userA, deleteCommand)).resolves.toMatchObject({
      success: false,
      error: { code: 'personal_data_snapshot_conflict' }
    });
  });
});
