import { readFile } from 'node:fs/promises';
import { planningApiResponseSchema, type PlanningApiRequest } from '@fitness/contracts';
import { createMealPlanEditingService } from '../../../packages/application/src/index';
import {
  TEST_DAILY_MENU_CATALOG,
  TEST_DAILY_MENU_TEMPLATES,
  TEST_NUTRITION_SNAPSHOTS,
  TEST_RECIPE_TEMPLATES
} from '../../../data/nutrition-fixtures/src/index';
import { InMemoryPlanningRepository } from '../../../packages/persistence/src/index';
import {
  ReviewedNutritionCache,
  StaticDailyMenuCatalogProvider,
  StaticRecipeTemplateProvider
} from '../../../packages/providers/src/index';
import { createPlanningApiHandler } from '../../../cloudfunctions/planning-api/src/handler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface PageOptions {
  readonly data: Record<string, unknown>;
  onLoad(): Promise<void> | void;
  refreshContext(): Promise<void>;
  onInventoryNameInput(event: IndexedTextEvent): void;
  onAddInventoryRow(): void;
  onRemoveInventoryRow(event: IndexedEvent): void;
  onResolveInventoryRow(event: IndexedEvent): Promise<void>;
  onSaveInventoryAndGenerate(): Promise<void>;
  onResumeInventoryGeneration(): Promise<void>;
  onClearDamagedInventoryGeneration(): void;
  onLockChange(event: IndexedSwitchEvent): Promise<void>;
  onRecipeChange(event: RecipePickerEvent): Promise<void>;
  onCandidateDecisionChange(event: TextEvent): void;
  onConfirmCandidateDecision(): Promise<void>;
  onRecordCompletion(): Promise<void>;
  onRetryRecalculation(): Promise<void>;
}

interface IndexedEvent {
  readonly currentTarget: { readonly dataset: { readonly index: number } };
}

interface IndexedSwitchEvent extends IndexedEvent {
  readonly detail: { readonly value: boolean };
}

interface IndexedTextEvent extends IndexedEvent {
  readonly detail: { readonly value: string };
}

interface RecipePickerEvent {
  readonly detail: { readonly value: string };
  readonly currentTarget: {
    readonly dataset: { readonly dayIndex: number; readonly mealIndex: number };
  };
}

interface TextEvent { readonly detail: { readonly value: string } }

interface PageInstance extends PageOptions {
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>): void;
}

const calls: PlanningApiRequest[] = [];
const responses: unknown[] = [];
const storage = new Map<string, unknown>();
let apiCallOverride: ((request: PlanningApiRequest) => Promise<unknown>) | undefined;
let registeredPage: PageOptions | undefined;

vi.mock('../../services/planning-api', () => ({
  planningApiClient: {
    call(request: PlanningApiRequest) {
      calls.push(request);
      return Promise.resolve().then(() => (
        apiCallOverride === undefined ? responses.shift() : apiCallOverride(request)
      )).then((response) => (
        planningApiResponseSchema.parse(response)
      ));
    }
  }
}));

function emptyContextResponse() {
  return {
    success: true,
    data: {
      kind: 'current_context',
      bodyProfile: null,
      goal: null,
      trainingPlan: null,
      dailyEnergyTargets: [],
      dailyNutritionTargets: [],
      inventory: null,
      mealPlan: null,
      mealPlanStale: false,
      pendingMealPlanCandidate: null,
      pendingMealPlanTargetDiffs: [],
      selectableRecipes: [],
      selectableRecipesStatus: 'no_options',
      retryableRecalculationJob: null,
      latestVersions: {
        bodyProfile: 0,
        goal: 0,
        trainingPlan: 0,
        inventory: 0,
        mealPlan: 0,
        mealPlanDecision: 0,
        trainingCompletion: 1,
        recalculationJob: 0
      }
    }
  } as const;
}

const mealDates = [
  '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20',
  '2026-08-21', '2026-08-22', '2026-08-23'
] as const;

function publicMealPlanVersion() {
  return {
    kind: 'meal_plan_version',
    id: 'meal-plan-1',
    version: 1,
    createdAt: '2026-08-10T00:00:00.000Z',
    weekStartDate: '2026-08-17',
    bodyProfileVersionId: 'profile-1',
    goalVersionId: 'goal-1',
    trainingPlanVersionId: 'training-1',
    inventoryVersionId: 'inventory-1',
    catalogVersionId: 'catalog-1',
    generationPolicyVersion: 'weekly-meal-generation-v1',
    supersedesVersionId: null,
    readiness: 'complete',
    days: mealDates.map((businessDate) => ({
      businessDate,
      dailyNutritionTargetVersionId: `target-${businessDate}`,
      dailyMenuTemplateVersionId: `menu-${businessDate}`,
      locked: false,
      manuallyModified: false,
      meals: [{
        slot: 'breakfast',
        recipeTemplateVersionId: 'recipe-1',
        servingMultiplier: 1,
        displayStatus: 'complete',
        dishNameZh: '测试早餐',
        ingredients: [{ displayNameZh: '测试米饭', grams: 100 }]
      }],
      ingredientAmounts: [{ foodId: 'food-rice', grams: 100 }],
      nutritionTotals: {
        energyKcal: 100,
        proteinG: 10,
        fatG: 2,
        carbohydrateG: 20,
        fiberG: 2,
        saturatedFatG: 0,
        addedSugarG: 0
      },
      nutritionSourceSnapshotIds: ['snapshot-rice']
    }))
  } as const;
}

function publicJob(status: 'failed_retryable' | 'completed' = 'failed_retryable') {
  return {
    kind: 'recalculation_job',
    id: 'job-from-server',
    triggerEventId: 'completion-1',
    triggerType: 'training_completion',
    affectedDates: ['2026-08-19'],
    status,
    createdAt: '2026-08-19T04:00:00.000Z',
    completedAt: status === 'completed' ? '2026-08-19T04:01:00.000Z' : null,
    candidateMealPlanVersionId: null,
    activatedMealPlanVersionId: status === 'completed' ? 'meal-plan-1' : null,
    failureCode: status === 'failed_retryable' ? 'provider_unavailable' : null
  } as const;
}

function deferred<T>() {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve(value: T) {
      if (resolvePromise === undefined) throw new Error('Deferred promise is unavailable');
      resolvePromise(value);
    }
  };
}

function foodResolved(canonicalNameZh: string) {
  return {
    success: true,
    data: {
      kind: 'food_name_resolved',
      resolution: {
        foodId: `food-${canonicalNameZh}`,
        canonicalNameZh,
        nutritionSnapshotId: `snapshot-${canonicalNameZh}`
      }
    }
  } as const;
}

function pageInstance(): PageInstance {
  if (registeredPage === undefined) throw new Error('Page was not registered');
  return {
    ...registeredPage,
    data: { ...registeredPage.data },
    setData(patch) { Object.assign(this.data, patch); }
  };
}

beforeEach(async () => {
  calls.length = 0;
  responses.length = 0;
  storage.clear();
  apiCallOverride = undefined;
  registeredPage = undefined;
  vi.resetModules();
  vi.stubGlobal('Page', (options: PageOptions) => { registeredPage = options; });
  vi.stubGlobal('wx', {
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => { storage.set(key, value); },
    removeStorageSync: (key: string) => { storage.delete(key); }
  });
  await import('./index');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('meal execution page controller', () => {
  it('refreshes public planning context on load', async () => {
    responses.push(emptyContextResponse());
    const page = pageInstance();

    await page.onLoad.call(page);

    expect(calls).toEqual([{ action: 'getCurrentContext' }]);
    expect(page.data.contextLoaded).toBe(true);
  });

  it('preserves completion success when meal recalculation is retryable and refreshes context', async () => {
    responses.push({
      success: true,
      data: {
        kind: 'training_completion_recorded',
        event: {
          kind: 'training_completion_event',
          id: 'completion-1',
          version: 1,
          trainingPlanVersionId: 'training-1',
          businessDate: '2026-08-19',
          completedDurationMinutes: 30,
          occurredAt: '2026-08-19T04:00:00.000Z'
        },
        dailyEnergyTargets: [],
        dailyNutritionTargets: [],
        recalculationStatus: 'failed_retryable',
        recalculationJob: publicJob(),
        candidateMealPlan: null,
        targetDiffs: []
      }
    });
    const retryableContext = emptyContextResponse();
    responses.push({
      ...retryableContext,
      data: {
        ...retryableContext.data,
        retryableRecalculationJob: publicJob(),
        latestVersions: { ...retryableContext.data.latestVersions, recalculationJob: 1 }
      }
    });
    const page = pageInstance();
    page.setData({
      businessToday: '2026-08-19',
      completionDate: '2026-08-19',
      completedDurationMinutes: '30',
      latestVersions: {
        bodyProfile: 0,
        goal: 0,
        trainingPlan: 0,
        inventory: 0,
        mealPlan: 0,
        mealPlanDecision: 0,
        trainingCompletion: 0,
        recalculationJob: 0
      }
    });

    await page.onRecordCompletion.call(page);

    expect(calls.map((request) => request.action)).toEqual([
      'recordTrainingCompletion',
      'getCurrentContext'
    ]);
    expect(page.data.savingFact).toBe(false);
    expect(page.data.recalculatingMeal).toBe(false);
    expect(page.data.factMessage).toBe('训练完成情况已保存。');
    expect(page.data.mealMessage).toContain('训练事实不受影响');
    expect(page.data.retryJobId).toBe('job-from-server');
  });

  it('turns a disappeared retry job into an explicit refresh state', async () => {
    responses.push(emptyContextResponse());
    const page = pageInstance();
    page.setData({
      retryJobId: 'job-from-old-training-plan',
      needsRecalculationStatusRefresh: false,
      mealMessage: '旧训练计划的餐单重算失败。'
    });

    await page.refreshContext.call(page); // retry job no longer belongs to the active plan

    expect(page.data.retryJobId).toBe('');
    expect(page.data.needsRecalculationStatusRefresh).toBe(true);
    expect(page.data.mealMessage).toContain('当前训练计划');
    expect(page.data.mealMessage).toContain('刷新');
  });

  it('blocks duplicate fact and recalculation submissions independently', async () => {
    const page = pageInstance();
    page.setData({ savingFact: true, recalculatingMeal: true, retryJobId: 'job-from-server' });

    await page.onRecordCompletion.call(page);
    await page.onRetryRecalculation.call(page);

    expect(calls).toEqual([]);
  });

  it('reuses the exact completion envelope after response loss and clears it only after confirmation', async () => {
    responses.push(Promise.reject(new Error('response lost after commit')));
    const firstPage = pageInstance();
    firstPage.setData({
      businessToday: '2026-08-19',
      completionDate: '2026-08-19',
      completedDurationMinutes: '30',
      latestVersions: {
        bodyProfile: 1,
        goal: 1,
        trainingPlan: 1,
        inventory: 1,
        mealPlan: 2,
        mealPlanDecision: 0,
        trainingCompletion: 4,
        recalculationJob: 2
      }
    });

    await firstPage.onRecordCompletion.call(firstPage);
    const lostRequest = calls[0];
    expect(lostRequest?.action).toBe('recordTrainingCompletion');
    expect(storage.size).toBe(1);

    responses.push({
      success: true,
      data: {
        kind: 'training_completion_recorded',
        event: {
          kind: 'training_completion_event',
          id: 'completion-replayed',
          version: 5,
          trainingPlanVersionId: 'training-1',
          businessDate: '2026-08-19',
          completedDurationMinutes: 30,
          occurredAt: '2026-08-19T04:00:00.000Z'
        },
        dailyEnergyTargets: [],
        dailyNutritionTargets: [],
        recalculationJob: null,
        candidateMealPlan: null,
        targetDiffs: [],
        recalculationStatus: 'not_required'
      }
    }, emptyContextResponse());
    const reenteredPage = pageInstance();
    reenteredPage.setData({
      businessToday: '2026-08-19',
      completionDate: '2026-08-19',
      completedDurationMinutes: '30',
      latestVersions: {
        bodyProfile: 1,
        goal: 1,
        trainingPlan: 1,
        inventory: 1,
        mealPlan: 2,
        mealPlanDecision: 0,
        trainingCompletion: 9,
        recalculationJob: 2
      }
    });

    await reenteredPage.onRecordCompletion.call(reenteredPage);

    expect(calls[1]).toEqual(lostRequest);
    expect(storage.size).toBe(0);

    responses.push({
      success: true,
      data: {
        kind: 'training_completion_recorded',
        event: {
          kind: 'training_completion_event',
          id: 'completion-new',
          version: 10,
          trainingPlanVersionId: 'training-1',
          businessDate: '2026-08-19',
          completedDurationMinutes: 30,
          occurredAt: '2026-08-19T04:05:00.000Z'
        },
        dailyEnergyTargets: [],
        dailyNutritionTargets: [],
        recalculationJob: null,
        candidateMealPlan: null,
        targetDiffs: [],
        recalculationStatus: 'not_required'
      }
    }, emptyContextResponse());
    const nextPage = pageInstance();
    nextPage.setData({
      businessToday: '2026-08-19',
      completionDate: '2026-08-19',
      completedDurationMinutes: '30',
      latestVersions: {
        bodyProfile: 1,
        goal: 1,
        trainingPlan: 1,
        inventory: 1,
        mealPlan: 2,
        mealPlanDecision: 0,
        trainingCompletion: 10,
        recalculationJob: 2
      }
    });
    await nextPage.onRecordCompletion.call(nextPage);

    expect(calls[3]).toMatchObject({
      action: 'recordTrainingCompletion',
      payload: { expectedVersion: 10 }
    });
    if (
      lostRequest?.action !== 'recordTrainingCompletion'
      || calls[3]?.action !== 'recordTrainingCompletion'
    ) {
      throw new Error('Expected completion requests');
    }
    expect(calls[3].payload.idempotencyKey).not.toBe(lostRequest.payload.idempotencyKey);
  });

  it('discards a deterministic completion conflict and rebuilds it from the refreshed version', async () => {
    const refreshed = emptyContextResponse();
    responses.push(
      { success: false, error: { code: 'version_conflict', message: 'conflict' } },
      {
        ...refreshed,
        data: {
          ...refreshed.data,
          latestVersions: { ...refreshed.data.latestVersions, trainingCompletion: 9 }
        }
      }
    );
    const page = pageInstance();
    page.setData({
      businessToday: '2026-08-19',
      completionDate: '2026-08-19',
      completedDurationMinutes: '30',
      latestVersions: { ...emptyContextResponse().data.latestVersions, trainingCompletion: 4 }
    });

    await page.onRecordCompletion.call(page);
    const conflicted = calls[0];
    expect(storage.size).toBe(0);
    expect((page.data.latestVersions as { trainingCompletion: number }).trainingCompletion).toBe(9);

    responses.push({
      success: true,
      data: {
        kind: 'training_completion_recorded',
        event: {
          kind: 'training_completion_event', id: 'completion-after-conflict', version: 10,
          trainingPlanVersionId: 'training-1', businessDate: '2026-08-19',
          completedDurationMinutes: 30, occurredAt: '2026-08-19T04:05:00.000Z'
        },
        dailyEnergyTargets: [], dailyNutritionTargets: [], recalculationJob: null,
        candidateMealPlan: null, targetDiffs: [], recalculationStatus: 'not_required'
      }
    }, emptyContextResponse());
    await page.onRecordCompletion.call(page);

    expect(calls[2]).toMatchObject({
      action: 'recordTrainingCompletion', payload: { expectedVersion: 9 }
    });
    if (conflicted?.action !== 'recordTrainingCompletion' || calls[2]?.action !== 'recordTrainingCompletion') {
      throw new Error('Expected completion requests');
    }
    expect(calls[2].payload.idempotencyKey).not.toBe(conflicted.payload.idempotencyKey);
  });

  it('discards a deterministic lock conflict and rebuilds it from the refreshed version', async () => {
    const refreshed = emptyContextResponse();
    responses.push(
      { success: false, error: { code: 'version_conflict', message: 'conflict' } },
      {
        ...refreshed,
        data: {
          ...refreshed.data,
          latestVersions: { ...refreshed.data.latestVersions, mealPlan: 9 }
        }
      }
    );
    const page = pageInstance();
    const mealDays = [{ businessDate: '2026-08-18', meals: [] }];
    page.setData({
      businessToday: '2026-08-10', mealDays,
      latestVersions: { ...emptyContextResponse().data.latestVersions, mealPlan: 4 }
    });

    await page.onLockChange.call(page, {
      detail: { value: true }, currentTarget: { dataset: { index: 0 } }
    });
    const conflicted = calls[0];
    expect(storage.size).toBe(0);

    responses.push(
      { success: true, data: { kind: 'meal_plan_updated', version: publicMealPlanVersion() } },
      emptyContextResponse()
    );
    page.setData({ mealDays });
    await page.onLockChange.call(page, {
      detail: { value: true }, currentTarget: { dataset: { index: 0 } }
    });

    expect(calls[2]).toMatchObject({ action: 'setMealPlanDayLock', payload: { expectedVersion: 9 } });
    if (conflicted?.action !== 'setMealPlanDayLock' || calls[2]?.action !== 'setMealPlanDayLock') {
      throw new Error('Expected lock requests');
    }
    expect(calls[2].payload.idempotencyKey).not.toBe(conflicted.payload.idempotencyKey);
  });

  it('retries the discoverable failed job with the server recalculation-job version', async () => {
    responses.push({
      success: true,
      data: {
        kind: 'meal_plan_recalculation_processed',
        recalculationJob: publicJob('completed'),
        candidateMealPlan: null,
        activatedMealPlan: publicMealPlanVersion(),
        targetDiffs: []
      }
    });
    responses.push(emptyContextResponse());
    const page = pageInstance();
    page.setData({
      retryJobId: 'job-from-server',
      latestVersions: {
        bodyProfile: 1,
        goal: 1,
        trainingPlan: 1,
        inventory: 1,
        mealPlan: 9,
        mealPlanDecision: 0,
        trainingCompletion: 1,
        recalculationJob: 4
      }
    });

    await page.onRetryRecalculation.call(page);

    expect(calls[0]).toMatchObject({
      action: 'retryPendingRecalculation',
      payload: {
        expectedVersion: 4,
        payload: { recalculationJobId: 'job-from-server' }
      }
    });
    expect(calls.map((request) => request.action)).toEqual([
      'retryPendingRecalculation',
      'getCurrentContext'
    ]);
  });

  it('requires every inventory row to resolve, then saves before generating and refreshes context', async () => {
    responses.push(foodResolved('测试米饭'));
    responses.push(foodResolved('测试鸡胸肉'));
    responses.push({
      success: true,
      data: {
        kind: 'inventory_saved',
        version: {
          kind: 'inventory_version',
          id: 'inventory-1',
          version: 1,
          createdAt: '2026-08-10T00:00:00.000Z',
          items: [
            { foodId: 'food-rice', nutritionSnapshotId: 'snapshot-rice', availableGrams: 5000 },
            { foodId: 'food-chicken', nutritionSnapshotId: 'snapshot-chicken', availableGrams: 3000 }
          ]
        }
      }
    });
    responses.push({
      success: true,
      data: { kind: 'weekly_meal_plan_generated', version: publicMealPlanVersion() }
    });
    responses.push(emptyContextResponse());
    const page = pageInstance();
    page.setData({
      businessToday: '2026-08-10',
      generationWeekStart: '2026-08-17',
      inventoryRows: [
        {
          key: 'row-rice',
          resolutionToken: 0,
          name: '测试米饭',
          availableGrams: '5000',
          resolutionStatus: 'idle',
          resolutionMessage: ''
        },
        {
          key: 'row-chicken',
          resolutionToken: 0,
          name: '测试鸡胸肉',
          availableGrams: '3000',
          resolutionStatus: 'idle',
          resolutionMessage: ''
        }
      ],
      latestVersions: {
        bodyProfile: 1,
        goal: 1,
        trainingPlan: 1,
        inventory: 0,
        mealPlan: 0,
        mealPlanDecision: 0,
        trainingCompletion: 0,
        recalculationJob: 0
      }
    });

    await page.onResolveInventoryRow.call(page, { currentTarget: { dataset: { index: 0 } } });
    expect(page.data.canSaveInventory).toBe(false);
    await page.onResolveInventoryRow.call(page, { currentTarget: { dataset: { index: 1 } } });
    expect(page.data.canSaveInventory).toBe(true);
    await page.onSaveInventoryAndGenerate.call(page);

    expect(calls.map((request) => request.action)).toEqual([
      'resolveFoodName',
      'resolveFoodName',
      'saveInventory',
      'generateWeeklyMealPlan',
      'getCurrentContext'
    ]);
    expect(calls[2]).toMatchObject({
      action: 'saveInventory',
      payload: {
        payload: {
          items: [
            { name: '测试米饭', availableGrams: 5000 },
            { name: '测试鸡胸肉', availableGrams: 3000 }
          ]
        }
      }
    });
  });

  it('resumes an exact generation request after response loss without saving another inventory', async () => {
    responses.push({
      success: true,
      data: {
        kind: 'inventory_saved',
        version: {
          kind: 'inventory_version', id: 'inventory-1', version: 1,
          createdAt: '2026-08-10T00:00:00.000Z',
          items: [{ foodId: 'food-rice', nutritionSnapshotId: 'snapshot-rice', availableGrams: 5000 }]
        }
      }
    }, Promise.reject(new Error('generation response lost after commit')));
    const firstPage = pageInstance();
    firstPage.setData({
      businessToday: '2026-08-10', generationWeekStart: '2026-08-17', canSaveInventory: true,
      inventoryRows: [{
        key: 'row-rice', resolutionToken: 0, name: '测试米饭', availableGrams: '5000',
        resolutionStatus: 'resolved', resolutionMessage: '已校验'
      }],
      latestVersions: { ...emptyContextResponse().data.latestVersions, inventory: 0, mealPlan: 0 }
    });

    await firstPage.onSaveInventoryAndGenerate.call(firstPage);
    const firstGenerate = calls.find((request) => request.action === 'generateWeeklyMealPlan');
    expect(storage.has('fitness.inventoryGenerationWorkflow.v1')).toBe(true);

    const reenteredPage = pageInstance();
    responses.push(emptyContextResponse());
    await reenteredPage.onLoad.call(reenteredPage);
    reenteredPage.setData({
      businessToday: '2026-08-10', generationWeekStart: '2026-08-24',
      inventoryRows: [{
        key: 'changed-row', resolutionToken: 0, name: '测试鸡胸肉', availableGrams: '3000',
        resolutionStatus: 'resolved', resolutionMessage: '已校验'
      }]
    });
    await reenteredPage.onSaveInventoryAndGenerate.call(reenteredPage);
    expect(calls.filter((request) => request.action === 'saveInventory')).toHaveLength(1);
    expect(calls.filter((request) => request.action === 'generateWeeklyMealPlan')).toHaveLength(1);
    expect(reenteredPage.data.inventoryGenerationRecoveryMessage).toContain('先恢复');

    responses.push(
      { success: true, data: { kind: 'weekly_meal_plan_generated', version: publicMealPlanVersion() } },
      emptyContextResponse()
    );
    await reenteredPage.onResumeInventoryGeneration.call(reenteredPage);

    const saveCalls = calls.filter((request) => request.action === 'saveInventory');
    const generateCalls = calls.filter((request) => request.action === 'generateWeeklyMealPlan');
    expect(saveCalls).toHaveLength(1);
    expect(generateCalls).toHaveLength(2);
    expect(generateCalls[1]).toEqual(firstGenerate);
    expect(storage.has('fitness.inventoryGenerationWorkflow.v1')).toBe(false);
  });

  it('replays a committed generation through the real handler without creating a second inventory', async () => {
    const repository = new InMemoryPlanningRepository();
    let sequence = 0;
    const balancedSnapshots = TEST_NUTRITION_SNAPSHOTS.map((snapshot) => ({
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
    }));
    const handler = createPlanningApiHandler(createMealPlanEditingService({
      repository,
      now: () => '2026-08-10T00:00:00.000Z',
      nextId: (prefix) => `${prefix}-${String(++sequence)}`,
      providers: {
        nutrition: new ReviewedNutritionCache({ mode: 'test', snapshots: balancedSnapshots }),
        recipes: new StaticRecipeTemplateProvider({ mode: 'test', templates: TEST_RECIPE_TEMPLATES }),
        menus: new StaticDailyMenuCatalogProvider({
          mode: 'test', catalog: TEST_DAILY_MENU_CATALOG, menus: TEST_DAILY_MENU_TEMPLATES
        }),
        allowTestFixtures: true
      }
    }));
    await handler({
      action: 'completePlanningSetup',
      payload: {
        expectedVersions: { bodyProfile: 0, goal: 0, trainingPlan: 0 },
        idempotencyKey: 'workflow-real-setup-001',
        bodyProfile: {
          ageYears: 30, sexCode: 0, heightCm: 175, weightKg: 60,
          healthScopeConfirmed: true, nonTrainingActivity: 'light',
          allergens: [], avoidFoods: [], dietPreferences: [], businessTimezone: 'Asia/Shanghai'
        },
        goal: { goal: 'fat_loss', effectiveDate: '2026-08-10', targetDate: '2026-10-30' },
        trainingPlan: {
          weekStartDate: '2026-08-17', businessTimezone: 'Asia/Shanghai', sessions: []
        }
      }
    }, { userId: 'trusted-workflow-user' });

    let loseFirstGenerationResponse = true;
    apiCallOverride = async (request) => {
      const response = await handler(request, { userId: 'trusted-workflow-user' });
      if (request.action === 'generateWeeklyMealPlan' && loseFirstGenerationResponse) {
        loseFirstGenerationResponse = false;
        throw new Error('generation response lost after real commit');
      }
      return response;
    };
    const rows = TEST_NUTRITION_SNAPSHOTS.map((snapshot, index) => ({
      key: `real-row-${String(index)}`,
      resolutionToken: 0,
      name: snapshot.canonicalNameZh,
      availableGrams: '50000',
      resolutionStatus: 'resolved' as const,
      resolutionMessage: '已校验'
    }));
    const firstPage = pageInstance();
    firstPage.setData({
      businessToday: '2026-08-10', generationWeekStart: '2026-08-17',
      canSaveInventory: true, inventoryRows: rows,
      latestVersions: { ...emptyContextResponse().data.latestVersions, inventory: 0, mealPlan: 0 }
    });

    await firstPage.onSaveInventoryAndGenerate.call(firstPage);
    const firstState = await repository.read('trusted-workflow-user');
    expect(firstState.inventories).toHaveLength(1);
    expect(firstState.mealPlans).toHaveLength(1);
    expect(storage.get('fitness.inventoryGenerationWorkflow.v1')).toMatchObject({
      stage: 'generation_pending'
    });

    const reenteredPage = pageInstance();
    await reenteredPage.onLoad.call(reenteredPage);
    await reenteredPage.onResumeInventoryGeneration.call(reenteredPage);

    const finalState = await repository.read('trusted-workflow-user');
    const activeInventory = finalState.inventories.find((version) => (
      version.id === finalState.activeInventoryVersionId
    ));
    const activeMeal = finalState.mealPlans.find((version) => (
      version.id === finalState.activeMealPlanVersionId
    ));
    expect(finalState.inventories).toHaveLength(1);
    expect(finalState.mealPlans).toHaveLength(1);
    expect(activeMeal?.inventoryVersionId).toBe(activeInventory?.id);
    const generationCalls = calls.filter((request) => request.action === 'generateWeeklyMealPlan');
    expect(generationCalls).toHaveLength(2);
    expect(generationCalls[1]).toEqual(generationCalls[0]);
    expect(storage.has('fitness.inventoryGenerationWorkflow.v1')).toBe(false);
    expect(storage.has('fitness.pendingMealCommand.v1.saveInventory')).toBe(false);
    expect(storage.has('fitness.pendingMealCommand.v1.generateWeeklyMealPlan')).toBe(false);
  });

  it('replays the exact inventory request before generation when the inventory response was lost', async () => {
    responses.push(Promise.reject(new Error('inventory response lost after commit')));
    const firstPage = pageInstance();
    firstPage.setData({
      businessToday: '2026-08-10', generationWeekStart: '2026-08-17', canSaveInventory: true,
      inventoryRows: [{
        key: 'row-rice', resolutionToken: 0, name: '测试米饭', availableGrams: '5000',
        resolutionStatus: 'resolved', resolutionMessage: '已校验'
      }],
      latestVersions: { ...emptyContextResponse().data.latestVersions, inventory: 0, mealPlan: 0 }
    });

    await firstPage.onSaveInventoryAndGenerate.call(firstPage);
    const firstSave = calls.find((request) => request.action === 'saveInventory');
    expect(storage.get('fitness.inventoryGenerationWorkflow.v1')).toMatchObject({
      stage: 'inventory_pending', inventoryVersionId: null
    });

    responses.push(
      emptyContextResponse(),
      {
        success: true,
        data: {
          kind: 'inventory_saved',
          version: {
            kind: 'inventory_version', id: 'inventory-1', version: 1,
            createdAt: '2026-08-10T00:00:00.000Z',
            items: [{ foodId: 'food-rice', nutritionSnapshotId: 'snapshot-rice', availableGrams: 5000 }]
          }
        }
      },
      { success: true, data: { kind: 'weekly_meal_plan_generated', version: publicMealPlanVersion() } },
      emptyContextResponse()
    );
    const reenteredPage = pageInstance();
    await reenteredPage.onLoad.call(reenteredPage);
    await reenteredPage.onResumeInventoryGeneration.call(reenteredPage);

    const saveCalls = calls.filter((request) => request.action === 'saveInventory');
    expect(saveCalls).toHaveLength(2);
    expect(saveCalls[1]).toEqual(firstSave);
    expect(calls.filter((request) => request.action === 'generateWeeklyMealPlan')).toHaveLength(1);
    expect(storage.has('fitness.inventoryGenerationWorkflow.v1')).toBe(false);
  });

  it('fails closed on damaged workflow storage and clears it only through explicit recovery', async () => {
    storage.set('fitness.inventoryGenerationWorkflow.v1', {
      stage: 'generation_pending', inventoryRequest: { action: 'saveInventory' }
    });
    responses.push(emptyContextResponse());
    const page = pageInstance();

    await page.onLoad.call(page);

    expect(page.data.inventoryGenerationRecoveryDamaged).toBe(true);
    expect(page.data.inventoryGenerationRecoveryMessage).toContain('恢复记录已损坏');
    await page.onResumeInventoryGeneration.call(page);
    expect(calls).toEqual([{ action: 'getCurrentContext' }]);
    expect(storage.has('fitness.inventoryGenerationWorkflow.v1')).toBe(true);

    page.onClearDamagedInventoryGeneration.call(page);
    expect(storage.has('fitness.inventoryGenerationWorkflow.v1')).toBe(false);
    expect(page.data.inventoryGenerationRecoveryVisible).toBe(false);
    expect(page.data.generationMessage).toContain('已清除');
  });

  it('merges concurrent row resolutions by stable key when responses finish in reverse order', async () => {
    const first = deferred<ReturnType<typeof foodResolved>>();
    const second = deferred<ReturnType<typeof foodResolved>>();
    responses.push(first.promise, second.promise);
    const page = pageInstance();
    page.setData({
      inventoryRows: [
        {
          key: 'row-rice',
          resolutionToken: 0,
          name: '米饭',
          availableGrams: '500',
          resolutionStatus: 'idle',
          resolutionMessage: ''
        },
        {
          key: 'row-chicken',
          resolutionToken: 0,
          name: '鸡胸肉',
          availableGrams: '300',
          resolutionStatus: 'idle',
          resolutionMessage: ''
        }
      ]
    });

    const resolvingRice = page.onResolveInventoryRow.call(page, {
      currentTarget: { dataset: { index: 0 } }
    });
    const resolvingChicken = page.onResolveInventoryRow.call(page, {
      currentTarget: { dataset: { index: 1 } }
    });
    second.resolve(foodResolved('测试鸡胸肉'));
    await resolvingChicken;
    first.resolve(foodResolved('测试米饭'));
    await resolvingRice;

    expect(page.data.inventoryRows).toMatchObject([
      { key: 'row-rice', name: '测试米饭', resolutionStatus: 'resolved' },
      { key: 'row-chicken', name: '测试鸡胸肉', resolutionStatus: 'resolved' }
    ]);
  });

  it('does not resurrect a resolving row after it is removed while another row is added', async () => {
    const pending = deferred<ReturnType<typeof foodResolved>>();
    responses.push(pending.promise);
    const page = pageInstance();
    page.setData({
      inventoryRows: [
        {
          key: 'row-old',
          resolutionToken: 0,
          name: '旧食材',
          availableGrams: '100',
          resolutionStatus: 'idle',
          resolutionMessage: ''
        },
        {
          key: 'row-keep',
          resolutionToken: 0,
          name: '保留食材',
          availableGrams: '200',
          resolutionStatus: 'idle',
          resolutionMessage: ''
        }
      ]
    });

    const resolving = page.onResolveInventoryRow.call(page, {
      currentTarget: { dataset: { index: 0 } }
    });
    page.onAddInventoryRow.call(page);
    page.onRemoveInventoryRow.call(page, { currentTarget: { dataset: { index: 0 } } });
    pending.resolve(foodResolved('不应复活'));
    await resolving;

    expect(page.data.inventoryRows).toMatchObject([
      { key: 'row-keep', name: '保留食材' },
      { name: '', resolutionStatus: 'idle' }
    ]);
    expect(JSON.stringify(page.data.inventoryRows)).not.toContain('不应复活');
    expect(JSON.stringify(page.data.inventoryRows)).not.toContain('row-old');
  });

  it('invalidates a pending resolution when the same row name is edited', async () => {
    const pending = deferred<ReturnType<typeof foodResolved>>();
    responses.push(pending.promise);
    const page = pageInstance();
    page.setData({
      inventoryRows: [{
        key: 'row-edit',
        resolutionToken: 0,
        name: '旧名称',
        availableGrams: '100',
        resolutionStatus: 'idle',
        resolutionMessage: ''
      }]
    });

    const resolving = page.onResolveInventoryRow.call(page, {
      currentTarget: { dataset: { index: 0 } }
    });
    page.onInventoryNameInput.call(page, {
      detail: { value: '新名称' },
      currentTarget: { dataset: { index: 0 } }
    });
    pending.resolve(foodResolved('旧名称的解析结果'));
    await resolving;

    expect(page.data.inventoryRows).toMatchObject([{
      key: 'row-edit',
      name: '新名称',
      resolutionStatus: 'idle'
    }]);
  });

  it('shows provider row failures as a row re-resolution action', async () => {
    responses.push({
      success: false,
      error: {
        code: 'provider_unavailable',
        message: 'provider unavailable'
      }
    });
    const page = pageInstance();
    page.setData({
      inventoryRows: [{
        key: 'row-provider',
        resolutionToken: 0,
        name: '测试食材',
        availableGrams: '100',
        resolutionStatus: 'idle',
        resolutionMessage: ''
      }]
    });

    await page.onResolveInventoryRow.call(page, {
      currentTarget: { dataset: { index: 0 } }
    });

    expect(page.data.inventoryRows).toMatchObject([{
      key: 'row-provider',
      resolutionStatus: 'error'
    }]);
    expect(JSON.stringify(page.data.inventoryRows)).toContain('重新校验名称');
    expect(JSON.stringify(page.data.inventoryRows)).not.toContain('重试餐单重算');
  });

  it('uses day/slot metadata plus a server recipe picker and refreshes after lock, edit, and decision', async () => {
    responses.push({ success: true, data: { kind: 'meal_plan_updated', version: publicMealPlanVersion() } });
    responses.push(emptyContextResponse());
    responses.push({ success: true, data: { kind: 'meal_plan_updated', version: publicMealPlanVersion() } });
    responses.push(emptyContextResponse());
    responses.push({
      success: true,
      data: {
        kind: 'meal_plan_candidate_decided',
        decision: {
          kind: 'meal_plan_decision',
          id: 'decision-1',
          version: 1,
          candidateMealPlanVersionId: 'candidate-from-context',
          previousActiveMealPlanVersionId: 'meal-plan-1',
          decision: 'overwrite_locked',
          decidedAt: '2026-08-10T01:00:00.000Z',
          activatedMealPlanVersionId: 'candidate-from-context'
        },
        recalculationJob: publicJob('completed'),
        activatedMealPlan: publicMealPlanVersion()
      }
    });
    responses.push(emptyContextResponse());
    const page = pageInstance();
    page.setData({
      businessToday: '2026-08-10',
      mealDays: [{
        businessDate: '2026-08-18',
        meals: [{ slot: 'dinner', selectedRecipeIndex: 0 }]
      }],
      selectableRecipes: [
        { recipeTemplateVersionId: 'recipe-server-1', dishNameZh: '番茄鸡蛋' },
        { recipeTemplateVersionId: 'recipe-server-2', dishNameZh: '香菇鸡肉' }
      ],
      recipeSelectionAvailable: true,
      pendingCandidateId: 'candidate-from-context',
      selectedDecision: 'keep_existing',
      latestVersions: {
        bodyProfile: 1,
        goal: 1,
        trainingPlan: 1,
        inventory: 1,
        mealPlan: 2,
        mealPlanDecision: 0,
        trainingCompletion: 0,
        recalculationJob: 0
      }
    });

    await page.onLockChange.call(page, {
      detail: { value: true },
      currentTarget: { dataset: { index: 0 } }
    });
    page.setData({
      mealDays: [{
        businessDate: '2026-08-18',
        meals: [{ slot: 'dinner', selectedRecipeIndex: 0 }]
      }],
      selectableRecipes: [
        { recipeTemplateVersionId: 'recipe-server-1', dishNameZh: '番茄鸡蛋' },
        { recipeTemplateVersionId: 'recipe-server-2', dishNameZh: '香菇鸡肉' }
      ],
      recipeSelectionAvailable: true,
      pendingCandidateId: 'candidate-from-context',
      selectedDecision: 'keep_existing',
      latestVersions: {
        bodyProfile: 1,
        goal: 1,
        trainingPlan: 1,
        inventory: 1,
        mealPlan: 2,
        mealPlanDecision: 0,
        trainingCompletion: 0,
        recalculationJob: 0
      }
    });
    await page.onRecipeChange.call(page, {
      detail: { value: '1' },
      currentTarget: { dataset: { dayIndex: 0, mealIndex: 0 } }
    });
    page.setData({
      pendingCandidateId: 'candidate-from-context',
      selectedDecision: 'keep_existing',
      decisionOptions: [
        { value: 'keep_existing', label: '保留当前锁定餐单' },
        { value: 'overwrite_locked', label: '确认并覆盖锁定日' }
      ],
      latestVersions: {
        bodyProfile: 1,
        goal: 1,
        trainingPlan: 1,
        inventory: 1,
        mealPlan: 2,
        mealPlanDecision: 0,
        trainingCompletion: 0,
        recalculationJob: 0
      }
    });
    page.onCandidateDecisionChange.call(page, { detail: { value: 'overwrite_locked' } });
    await page.onConfirmCandidateDecision.call(page);

    expect(calls.map((request) => request.action)).toEqual([
      'setMealPlanDayLock', 'getCurrentContext',
      'updateMealPlanDay', 'getCurrentContext',
      'decideMealPlanCandidate', 'getCurrentContext'
    ]);
    expect(calls[2]).toMatchObject({
      action: 'updateMealPlanDay',
      payload: { payload: { recipeTemplateVersionId: 'recipe-server-2' } }
    });
    expect(calls[4]).toMatchObject({
      action: 'decideMealPlanCandidate',
      payload: { payload: { decision: 'overwrite_locked' } }
    });
  });

  it('renders visible food, gram, date, completion, and recipe controls without an internal-ID field', async () => {
    const markup = await readFile(new URL('./index.wxml', import.meta.url), 'utf8');
    const visibleControls = [...markup.matchAll(/<(?:input|picker)\b[^>]*>/g)]
      .map((match) => match[0])
      .join('\n');

    expect(visibleControls).toContain('bindinput="onInventoryNameInput"');
    expect(visibleControls).toContain('bindinput="onInventoryGramsInput"');
    expect(visibleControls).toContain('bindchange="onRecipeChange"');
    expect(visibleControls).toContain('bindchange="onCompletionDateChange"');
    expect(visibleControls).toContain('bindinput="onCompletionMinutesInput"');
    expect(visibleControls).not.toMatch(/(?:food|recipe|version|candidate|job|user)[-_ ]?id/i);
    expect(markup).toContain('{{ingredient.displayNameZh}}');
    expect(markup).toContain('{{ingredient.gramsText}}');
    expect(markup).toContain('{{item.targetChangeText}}');
    expect(markup).toContain('{{item.mealChangeText}}');
    expect(markup).toContain('wx:if="{{recipeAvailabilityMessage}}"');
    expect(markup).toContain('disabled="{{!day.editable || updatingMeal || !recipeSelectionAvailable}}"');
    expect(markup).toContain('刷新备选菜品');
    expect(markup).toContain('wx:if="{{needsRecalculationStatusRefresh}}"');
    expect(markup).toContain('刷新重算状态');
    expect(markup).toContain('bindtap="onResumeInventoryGeneration"');
    expect(markup).toContain('bindtap="onClearDamagedInventoryGeneration"');
    expect(markup).toContain('wx:if="{{inventoryGenerationRecoveryVisible}}"');
    expect(markup).toContain('disabled="{{savingInventory || generatingMeal || inventoryGenerationRecoveryDamaged}}"');
  });
});
