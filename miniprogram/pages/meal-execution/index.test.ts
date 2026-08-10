import { readFile } from 'node:fs/promises';
import type { PlanningApiRequest } from '@fitness/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface PageOptions {
  readonly data: Record<string, unknown>;
  onLoad(): Promise<void> | void;
  onResolveInventoryRow(event: IndexedEvent): Promise<void>;
  onSaveInventoryAndGenerate(): Promise<void>;
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
let registeredPage: PageOptions | undefined;

vi.mock('../../services/planning-api', () => ({
  planningApiClient: {
    call(request: PlanningApiRequest) {
      calls.push(request);
      return Promise.resolve(responses.shift());
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
      latestVersions: {
        bodyProfile: 0,
        goal: 0,
        trainingPlan: 0,
        inventory: 0,
        mealPlan: 0,
        mealPlanDecision: 0,
        trainingCompletion: 1
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
  registeredPage = undefined;
  vi.resetModules();
  vi.stubGlobal('Page', (options: PageOptions) => { registeredPage = options; });
  vi.stubGlobal('wx', {
    getStorageSync: () => undefined,
    setStorageSync: () => undefined,
    removeStorageSync: () => undefined
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
        recalculationStatus: 'failed_retryable',
        recalculationJob: { id: 'job-from-server', failureCode: 'provider_unavailable' }
      }
    });
    responses.push(emptyContextResponse());
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
        trainingCompletion: 0
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

  it('blocks duplicate fact and recalculation submissions independently', async () => {
    const page = pageInstance();
    page.setData({ savingFact: true, recalculatingMeal: true, retryJobId: 'job-from-server' });

    await page.onRecordCompletion.call(page);
    await page.onRetryRecalculation.call(page);

    expect(calls).toEqual([]);
  });

  it('requires every inventory row to resolve, then saves before generating and refreshes context', async () => {
    responses.push({
      success: true,
      data: {
        kind: 'food_name_resolved',
        resolution: { canonicalNameZh: '测试米饭' }
      }
    });
    responses.push({
      success: true,
      data: {
        kind: 'food_name_resolved',
        resolution: { canonicalNameZh: '测试鸡胸肉' }
      }
    });
    responses.push({ success: true, data: { kind: 'inventory_saved' } });
    responses.push({ success: true, data: { kind: 'weekly_meal_plan_generated' } });
    responses.push(emptyContextResponse());
    const page = pageInstance();
    page.setData({
      businessToday: '2026-08-10',
      generationWeekStart: '2026-08-17',
      inventoryRows: [
        { name: '测试米饭', availableGrams: '5000', resolutionStatus: 'idle', resolutionMessage: '' },
        { name: '测试鸡胸肉', availableGrams: '3000', resolutionStatus: 'idle', resolutionMessage: '' }
      ],
      latestVersions: {
        bodyProfile: 1,
        goal: 1,
        trainingPlan: 1,
        inventory: 0,
        mealPlan: 0,
        mealPlanDecision: 0,
        trainingCompletion: 0
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

  it('uses day/slot metadata plus a server recipe picker and refreshes after lock, edit, and decision', async () => {
    responses.push({ success: true, data: { kind: 'meal_plan_updated' } });
    responses.push(emptyContextResponse());
    responses.push({ success: true, data: { kind: 'meal_plan_updated' } });
    responses.push(emptyContextResponse());
    responses.push({ success: true, data: { kind: 'meal_plan_candidate_decided' } });
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
      pendingCandidateId: 'candidate-from-context',
      selectedDecision: 'keep_existing',
      latestVersions: {
        bodyProfile: 1,
        goal: 1,
        trainingPlan: 1,
        inventory: 1,
        mealPlan: 2,
        mealPlanDecision: 0,
        trainingCompletion: 0
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
      pendingCandidateId: 'candidate-from-context',
      selectedDecision: 'keep_existing',
      latestVersions: {
        bodyProfile: 1,
        goal: 1,
        trainingPlan: 1,
        inventory: 1,
        mealPlan: 2,
        mealPlanDecision: 0,
        trainingCompletion: 0
      }
    });
    await page.onRecipeChange.call(page, {
      detail: { value: '1' },
      currentTarget: { dataset: { dayIndex: 0, mealIndex: 0 } }
    });
    page.setData({
      pendingCandidateId: 'candidate-from-context',
      selectedDecision: 'keep_existing',
      latestVersions: {
        bodyProfile: 1,
        goal: 1,
        trainingPlan: 1,
        inventory: 1,
        mealPlan: 2,
        mealPlanDecision: 0,
        trainingCompletion: 0
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
  });
});
