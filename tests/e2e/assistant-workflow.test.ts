import type {
  AssistantLanguageModelInput,
  AssistantLanguageModelProvider,
  AssistantLanguageModelResult
} from '../../packages/agent/src/index';
import {
  createMealPlanRecalculationService,
  selectManualMealPortion,
  selectManualMealReplacement
} from '../../packages/application/src/index';
import type {
  AssistantApiResponse,
  PlanningApiRequest,
  PlanningApiResponse
} from '../../packages/contracts/src/index';
import type {
  MealPlanDay,
  MealPlanVersion,
  MealSlot,
  NutrientValues,
  NutritionDataSnapshot,
  PlanningAggregateState,
  TrainingSessionPayload
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
import { describe, expect, it } from 'vitest';
import { createAssistantApiComposition } from '../../cloudfunctions/assistant-api/src/handler';
import { createPlanningApiHandler } from '../../cloudfunctions/planning-api/src/handler';

const NOW = '2026-08-10T00:00:00.000Z';
const WEEK_START = '2026-08-17';
const SOURCE_DATE = '2026-08-19';
const TARGET_DATE = '2026-08-20';
const RESIZE_DATE = '2026-08-22';
function lastUserMessage(input: AssistantLanguageModelInput): string {
  return [...input.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
}

class ScenarioLanguageModel implements AssistantLanguageModelProvider {
  public readonly inputs: AssistantLanguageModelInput[] = [];
  private holdObservedResolve: (() => void) | undefined;
  private readonly holdObserved = new Promise<void>((resolve) => {
    this.holdObservedResolve = resolve;
  });
  private holdResolve: ((value: AssistantLanguageModelResult) => void) | undefined;

  public generateIntent(input: AssistantLanguageModelInput): Promise<AssistantLanguageModelResult> {
    this.inputs.push(input);
    const message = lastUserMessage(input);
    if (message === '测试双重格式错误') {
      return Promise.resolve({ rawText: input.repairAttempt === 0 ? '{bad' : '{still bad' });
    }
    if (message === '测试模型供应商不可用') {
      return Promise.reject(new Error('supplier secret must stay private'));
    }
    if (message === '测试隔离中的挂起请求') {
      this.holdObservedResolve?.();
      return new Promise((resolve) => { this.holdResolve = resolve; });
    }

    const dates = Array.from(message.matchAll(/\d{4}-\d{2}-\d{2}/g), (match) => match[0]);
    if (message.includes('训练') && dates.length >= 2) {
      return Promise.resolve({ rawText: JSON.stringify({
        kind: 'command', intent: 'move_training_day',
        evidence: { sourceDateText: dates[0], targetDateText: dates[1] }
      }) });
    }
    if (message.includes('训练') && dates.length === 1) {
      return Promise.resolve({ rawText: JSON.stringify({
        kind: 'clarify', intent: 'move_training_day', missingFields: ['target_date']
      }) });
    }

    const replace = message.match(
      /^(?:请)?把 (\d{4}-\d{2}-\d{2}) 的(早餐|午餐|晚餐|加餐)换成(.+)$/
    );
    if (replace !== null) {
      return Promise.resolve({ rawText: JSON.stringify({
        kind: 'command', intent: 'replace_meal', evidence: {
          businessDateText: replace[1], mealSlotText: replace[2], dishNameText: replace[3]
        }
      }) });
    }

    const resize = message.match(
      /^(?:请)?把 (\d{4}-\d{2}-\d{2}) 的(早餐|午餐|晚餐|加餐)调整为(.+)$/
    );
    if (resize !== null) {
      return Promise.resolve({ rawText: JSON.stringify({
        kind: 'command', intent: 'resize_meal_portion', evidence: {
          businessDateText: resize[1], mealSlotText: resize[2], multiplierText: resize[3]
        }
      }) });
    }
    return Promise.resolve({
      rawText: JSON.stringify({ kind: 'reject', reason: 'unsupported_request' })
    });
  }

  public waitForHold(): Promise<void> {
    return this.holdObserved;
  }

  public releaseHold(): void {
    const resolve = this.holdResolve;
    if (resolve === undefined) throw new Error('No held model request');
    resolve({ rawText: JSON.stringify({ kind: 'reject', reason: 'unsupported_request' }) });
    this.holdResolve = undefined;
  }
}

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

function createHarness() {
  const repository = new InMemoryPlanningRepository();
  const model = new ScenarioLanguageModel();
  let sequence = 0;
  const nextId = (prefix: string): string => `${prefix}-e2e-${String(++sequence)}`;
  const planning = createMealPlanRecalculationService({
    repository,
    providers: fixtureProviders(),
    now: () => NOW,
    nextId
  });
  return {
    repository,
    model,
    planning,
    planningHandler: createPlanningApiHandler(planning),
    assistantHandler: createAssistantApiComposition({
      repository, planning, provider: model, now: () => NOW, nextId
    })
  };
}

type Harness = ReturnType<typeof createHarness>;

async function callPlanning(
  harness: Harness,
  userId: string,
  request: PlanningApiRequest
): Promise<PlanningApiResponse> {
  return harness.planningHandler(request, { userId });
}

async function prepareUser(
  harness: Harness,
  userId: string,
  sessions: readonly TrainingSessionPayload[] = [{
    businessDate: SOURCE_DATE,
    sessionCode: '02054',
    durationMinutes: 60
  }]
): Promise<void> {
  const setup = await callPlanning(harness, userId, {
    action: 'completePlanningSetup',
    payload: {
      expectedVersions: { bodyProfile: 0, goal: 0, trainingPlan: 0 },
      idempotencyKey: `${userId}-setup-0001`,
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
        weekStartDate: WEEK_START,
        businessTimezone: 'Asia/Shanghai',
        sessions
      }
    }
  });
  expect(setup).toMatchObject({
    success: true, data: { kind: 'planning_setup_completed' }
  });

  const inventory = await callPlanning(harness, userId, {
    action: 'saveInventory',
    payload: {
      expectedVersion: 0,
      idempotencyKey: `${userId}-inventory-0001`,
      payload: {
        items: TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS.map((snapshot) => ({
          name: snapshot.canonicalNameZh,
          availableGrams: 50_000
        }))
      }
    }
  });
  expect(inventory).toMatchObject({ success: true, data: { kind: 'inventory_saved' } });

  const generated = await callPlanning(harness, userId, {
    action: 'generateWeeklyMealPlan',
    payload: {
      expectedVersion: 0,
      idempotencyKey: `${userId}-meal-generate-0001`,
      payload: { weekStartDate: WEEK_START }
    }
  });
  expect(generated).toMatchObject({
    success: true, data: { kind: 'weekly_meal_plan_generated' }
  });
}

async function sendAssistant(
  harness: Harness,
  userId: string,
  expectedVersion: number,
  idempotencyKey: string,
  message: string
): Promise<AssistantApiResponse> {
  return harness.assistantHandler({
    action: 'sendAssistantMessage',
    payload: { expectedVersion, idempotencyKey, message }
  }, { userId });
}

function activeMealPlan(state: PlanningAggregateState): MealPlanVersion {
  const plan = state.mealPlans.find((candidate) => candidate.id === state.activeMealPlanVersionId);
  if (plan === undefined) throw new Error('Expected active meal plan');
  return plan;
}

function activeTrainingKcal(state: PlanningAggregateState): number {
  return state.dailyEnergyTargets
    .filter((target) => target.trainingPlanVersionId === state.activeTrainingPlanVersionId)
    .reduce((sum, target) => {
      if (target.energy.kind !== 'supported') throw new Error('Expected supported energy target');
      return sum + target.energy.trainingNetKcal;
    }, 0);
}

function roundOne(value: number): number {
  return Math.floor((value + Number.EPSILON) * 10 + 0.5) / 10;
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
    energyKcal: totals.energyKcal + roundOne(nutrients.energyKcal * factor),
    proteinG: totals.proteinG + roundOne(nutrients.proteinG * factor),
    fatG: totals.fatG + roundOne(nutrients.fatG * factor),
    carbohydrateG: totals.carbohydrateG + roundOne(nutrients.carbohydrateG * factor),
    fiberG: totals.fiberG + roundOne(nutrients.fiberG * factor),
    saturatedFatG: totals.saturatedFatG + roundOne(nutrients.saturatedFatG * factor),
    addedSugarG: totals.addedSugarG + roundOne(nutrients.addedSugarG * factor)
  };
}

function roundNutrients(totals: NutrientValues): NutrientValues {
  return {
    energyKcal: roundOne(totals.energyKcal),
    proteinG: roundOne(totals.proteinG),
    fatG: roundOne(totals.fatG),
    carbohydrateG: roundOne(totals.carbohydrateG),
    fiberG: roundOne(totals.fiberG),
    saturatedFatG: roundOne(totals.saturatedFatG),
    addedSugarG: roundOne(totals.addedSugarG)
  };
}

function independentlyRecomputeDay(day: MealPlanDay): Map<string, number> {
  const snapshots = new Map(
    TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS.map((snapshot) => [snapshot.id, snapshot])
  );
  const recipes = new Map(
    TEST_MEAL_PLANNING_RECIPE_TEMPLATES.map((recipe) => [recipe.id, recipe])
  );
  const aggregates = new Map<string, {
    readonly snapshot: NutritionDataSnapshot;
    grams: number;
  }>();

  for (const meal of day.meals) {
    const recipe = recipes.get(meal.recipeTemplateVersionId);
    if (recipe === undefined) throw new Error('Expected reviewed recipe');
    const displayedIngredients = recipe.ingredients.map((ingredient) => {
      const snapshot = snapshots.get(ingredient.nutritionSnapshotId);
      if (snapshot === undefined) throw new Error('Expected reviewed nutrition snapshot');
      const grams = roundOne(ingredient.grams * meal.servingMultiplier);
      const aggregate = aggregates.get(ingredient.foodId);
      if (aggregate === undefined) {
        aggregates.set(ingredient.foodId, { snapshot, grams });
      } else {
        aggregate.grams = roundOne(aggregate.grams + grams);
      }
      return { displayNameZh: snapshot.canonicalNameZh, grams };
    });
    expect(meal.ingredients).toEqual(displayedIngredients);
    expect(meal.dishNameZh).toBe(recipe.dishNameZh);
  }

  const ingredientAmounts = [...aggregates]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([foodId, aggregate]) => ({ foodId, grams: aggregate.grams }));
  expect(day.ingredientAmounts).toEqual(ingredientAmounts);

  let totals = zeroNutrients();
  for (const aggregate of aggregates.values()) {
    totals = addScaledNutrients(
      totals,
      aggregate.snapshot.nutrientsPer100g,
      aggregate.grams
    );
  }
  totals = roundNutrients(totals);
  expect(day.nutritionTotals).toEqual(totals);
  return new Map(ingredientAmounts.map((amount) => [amount.foodId, amount.grams]));
}

function independentlyRecomputeWeeklyUsage(plan: MealPlanVersion): Map<string, number> {
  const weekly = new Map<string, number>();
  for (const day of plan.days) {
    for (const [foodId, grams] of independentlyRecomputeDay(day)) {
      weekly.set(foodId, roundOne((weekly.get(foodId) ?? 0) + grams));
    }
  }
  return weekly;
}

function findFeasibleResize(
  state: PlanningAggregateState,
  businessDate: string,
  slot: MealSlot
): number {
  const plan = activeMealPlan(state);
  const day = plan.days.find((value) => value.businessDate === businessDate);
  const inventory = state.inventories.find((value) => value.id === state.activeInventoryVersionId);
  const profile = state.bodyProfiles.find((value) => value.id === state.activeBodyProfileVersionId);
  const target = state.dailyNutritionTargets.find(
    (value) => value.id === day?.dailyNutritionTargetVersionId
  );
  const currentMultiplier = day?.meals.find((meal) => meal.slot === slot)?.servingMultiplier;
  if (inventory === undefined) throw new Error('Expected active portion inventory');
  if (profile === undefined) throw new Error('Expected active portion profile');
  if (target === undefined) throw new Error('Expected active portion target');
  if (currentMultiplier === undefined) throw new Error('Expected current portion meal');

  const candidates = Array.from({ length: 21 }, (_unused, index) => 0.5 + index * 0.05)
    .map(roundOne)
    .filter((candidate) => candidate !== currentMultiplier)
    .sort((left, right) => (
      Math.abs(left - currentMultiplier) - Math.abs(right - currentMultiplier)
      || left - right
    ));
  for (const multiplier of candidates) {
    const selected = selectManualMealPortion({
      currentPlan: plan,
      businessDate,
      slot,
      multiplier,
      recipes: TEST_MEAL_PLANNING_RECIPE_TEMPLATES,
      snapshots: TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS,
      inventory,
      target,
      allergens: profile.payload.allergens,
      avoidFoodIds: profile.payload.avoidFoods,
      allowTestFixtures: true
    });
    if (!('kind' in selected)) return multiplier;
  }
  throw new Error('Expected at least one feasible changed portion');
}

function findFeasibleReplacement(
  state: PlanningAggregateState,
  businessDate: string,
  slot: MealSlot,
  selectableRecipeIds: ReadonlySet<string>
) {
  const plan = activeMealPlan(state);
  const day = plan.days.find((value) => value.businessDate === businessDate);
  const inventory = state.inventories.find((value) => value.id === state.activeInventoryVersionId);
  const profile = state.bodyProfiles.find((value) => value.id === state.activeBodyProfileVersionId);
  const target = state.dailyNutritionTargets.find(
    (value) => value.id === day?.dailyNutritionTargetVersionId
  );
  const currentRecipeId = day?.meals.find((meal) => meal.slot === slot)?.recipeTemplateVersionId;
  if (inventory === undefined || profile === undefined || target === undefined) {
    throw new Error('Expected complete replacement prerequisites');
  }
  for (const replacementRecipe of TEST_MEAL_PLANNING_RECIPE_TEMPLATES) {
    if (
      replacementRecipe.id === currentRecipeId
      || !selectableRecipeIds.has(replacementRecipe.id)
    ) continue;
    const selected = selectManualMealReplacement({
      currentPlan: plan,
      businessDate,
      slot,
      replacementRecipe,
      recipes: TEST_MEAL_PLANNING_RECIPE_TEMPLATES,
      snapshots: TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS,
      inventory,
      target,
      allergens: profile.payload.allergens,
      avoidFoodIds: profile.payload.avoidFoods,
      allowTestFixtures: true
    });
    if (!('kind' in selected)) return replacementRecipe;
  }
  throw new Error('Expected at least one feasible reviewed replacement');
}

function stateCounts(state: PlanningAggregateState) {
  return {
    conversationVersion: state.assistantConversation.version,
    messages: state.assistantConversation.recentMessages.length,
    assistantReceipts: state.assistantConversation.recentReceipts.length,
    trainingPlans: state.trainingPlans.length,
    mealPlans: state.mealPlans.length,
    jobs: state.recalculationJobs.length,
    domainReceipts: state.idempotencyRecords.length
  };
}

function withoutAssistant(state: PlanningAggregateState) {
  return { ...state, assistantConversation: undefined };
}

describe('bounded assistant end-to-end workflow', () => {
  it('executes all three commands, recomputes independently, replays once, and preserves locks', async () => {
    const harness = createHarness();
    const userId = 'assistant-e2e-user';
    await prepareUser(harness, userId);

    const beforeMove = await harness.repository.read(userId);
    const weeklyTrainingKcal = activeTrainingKcal(beforeMove);
    const moved = await sendAssistant(
      harness,
      userId,
      0,
      'assistant-e2e-move-0001',
      `把 ${SOURCE_DATE} 的训练移到 ${TARGET_DATE}`
    );
    expect(moved).toMatchObject({
      success: true,
      data: { kind: 'assistant_turn_completed', result: { kind: 'command_executed' } }
    });
    const afterMove = await harness.repository.read(userId);
    const movedPlan = afterMove.trainingPlans.find(
      (plan) => plan.id === afterMove.activeTrainingPlanVersionId
    );
    expect(movedPlan?.payload.sessions).toContainEqual({
      businessDate: TARGET_DATE, sessionCode: '02054', durationMinutes: 60
    });
    expect(movedPlan?.payload.sessions.some((session) => session.businessDate === SOURCE_DATE))
      .toBe(false);
    expect(activeTrainingKcal(afterMove)).toBe(weeklyTrainingKcal);
    expect(afterMove.recalculationJobs.at(-1)?.affectedDates).toEqual([
      SOURCE_DATE, TARGET_DATE
    ]);

    const context = await harness.planning.getCurrentContext(userId);
    const replacement = findFeasibleReplacement(
      afterMove,
      SOURCE_DATE,
      'dinner',
      new Set(context.selectableRecipes.map((recipe) => recipe.recipeTemplateVersionId))
    );
    const replaced = await sendAssistant(
      harness,
      userId,
      1,
      'assistant-e2e-replace-0001',
      `把 ${SOURCE_DATE} 的晚餐换成${replacement.dishNameZh}`
    );
    expect(replaced).toMatchObject({
      success: true,
      data: {
        kind: 'assistant_turn_completed',
        result: { kind: 'command_executed', command: 'replace_meal' }
      }
    });
    const afterReplace = await harness.repository.read(userId);
    const replacedDay = activeMealPlan(afterReplace).days.find(
      (day) => day.businessDate === SOURCE_DATE
    );
    expect(replacedDay?.meals.find((meal) => meal.slot === 'dinner')?.dishNameZh)
      .toBe(replacement.dishNameZh);
    expect(replacedDay).toMatchObject({ locked: true, manuallyModified: true });
    if (replacedDay === undefined) throw new Error('Expected replaced day');
    independentlyRecomputeDay(replacedDay);

    const multiplier = findFeasibleResize(afterReplace, RESIZE_DATE, 'lunch');
    const planBeforeResize = activeMealPlan(afterReplace);
    const usageBeforeResize = independentlyRecomputeWeeklyUsage(planBeforeResize);
    const resizeRequest = {
      expectedVersion: 2,
      idempotencyKey: 'assistant-e2e-resize-0001',
      message: `把 ${RESIZE_DATE} 的午餐调整为${String(multiplier)} 倍`
    } as const;
    const modelCallsBeforeResize = harness.model.inputs.length;
    const resized = await sendAssistant(
      harness,
      userId,
      resizeRequest.expectedVersion,
      resizeRequest.idempotencyKey,
      resizeRequest.message
    );
    const afterResize = await harness.repository.read(userId);
    const countsAfterResize = stateCounts(afterResize);
    const replayed = await sendAssistant(
      harness,
      userId,
      resizeRequest.expectedVersion,
      resizeRequest.idempotencyKey,
      resizeRequest.message
    );
    const afterReplay = await harness.repository.read(userId);
    expect(replayed).toEqual(resized);
    expect(stateCounts(afterReplay)).toEqual(countsAfterResize);
    expect(harness.model.inputs.length).toBe(modelCallsBeforeResize + 1);

    const resizedPlan = activeMealPlan(afterResize);
    const resizedDay = resizedPlan.days.find((day) => day.businessDate === RESIZE_DATE);
    expect(resizedDay?.meals.find((meal) => meal.slot === 'lunch')?.servingMultiplier)
      .toBe(multiplier);
    if (resizedDay === undefined) throw new Error('Expected resized day');
    independentlyRecomputeDay(resizedDay);
    const usageAfterResize = independentlyRecomputeWeeklyUsage(resizedPlan);
    expect([...usageAfterResize]).not.toEqual([...usageBeforeResize]);
    const inventory = afterResize.inventories.find(
      (value) => value.id === afterResize.activeInventoryVersionId
    );
    if (inventory === undefined) throw new Error('Expected active inventory');
    for (const item of inventory.items) {
      expect(usageAfterResize.get(item.foodId) ?? 0).toBeLessThanOrEqual(item.availableGrams);
    }

    const activeBeforeLockedMove = structuredClone(resizedPlan);
    const lockedMove = await sendAssistant(
      harness,
      userId,
      3,
      'assistant-e2e-locked-move-0001',
      `把 ${TARGET_DATE} 的训练移到 ${SOURCE_DATE}`
    );
    expect(lockedMove).toMatchObject({
      success: true,
      data: { kind: 'assistant_turn_completed', result: { kind: 'command_executed' } }
    });
    const afterLockedMove = await harness.repository.read(userId);
    expect(afterLockedMove.activeMealPlanVersionId).toBe(activeBeforeLockedMove.id);
    expect(activeMealPlan(afterLockedMove)).toEqual(activeBeforeLockedMove);
    const pendingJob = afterLockedMove.recalculationJobs.at(-1);
    expect(pendingJob).toMatchObject({
      status: 'pending',
      affectedDates: [SOURCE_DATE, TARGET_DATE],
      activatedMealPlanVersionId: null
    });
    const candidate = afterLockedMove.mealPlans.find(
      (plan) => plan.id === pendingJob?.candidateMealPlanVersionId
    );
    expect(candidate?.readiness).toBe('pending_confirmation');
    expect(afterLockedMove.mealPlanTargetDiffs.some((diff) => (
      diff.businessDate === SOURCE_DATE && diff.candidateMealPlanVersionId === candidate?.id
    ))).toBe(true);
  });

  it('repairs malformed output once and makes zero planning writes after the second failure', async () => {
    const harness = createHarness();
    const userId = 'assistant-malformed-user';
    await prepareUser(harness, userId);
    const before = await harness.repository.read(userId);

    const response = await sendAssistant(
      harness, userId, 0, 'assistant-malformed-0001', '测试双重格式错误'
    );

    expect(response).toMatchObject({
      success: true,
      data: {
        kind: 'assistant_turn_completed',
        result: { kind: 'assistant_unavailable', reason: 'model_output_invalid' }
      }
    });
    const malformedInputs = harness.model.inputs.filter(
      (input) => lastUserMessage(input) === '测试双重格式错误'
    );
    expect(malformedInputs.map((input) => input.repairAttempt)).toEqual([0, 1]);
    const after = await harness.repository.read(userId);
    expect(withoutAssistant(after)).toEqual(withoutAssistant(before));
  });

  it('keeps the planning API and deterministic resize usable when the model Provider is unavailable', async () => {
    const harness = createHarness();
    const userId = 'assistant-provider-user';
    await prepareUser(harness, userId);
    const before = await harness.repository.read(userId);

    const unavailable = await sendAssistant(
      harness, userId, 0, 'assistant-provider-0001', '测试模型供应商不可用'
    );
    expect(unavailable).toMatchObject({
      success: true,
      data: {
        kind: 'assistant_turn_completed',
        result: { kind: 'assistant_unavailable', reason: 'provider_unavailable' }
      }
    });
    const afterUnavailable = await harness.repository.read(userId);
    expect(withoutAssistant(afterUnavailable)).toEqual(withoutAssistant(before));

    const context = await callPlanning(harness, userId, { action: 'getCurrentContext' });
    expect(context).toMatchObject({
      success: true,
      data: {
        kind: 'current_context',
        latestVersions: { trainingPlan: 1, mealPlan: 1 }
      }
    });
    expect(JSON.stringify(context)).not.toContain(userId);

    const multiplier = findFeasibleResize(afterUnavailable, RESIZE_DATE, 'lunch');
    const resize = await callPlanning(harness, userId, {
      action: 'resizeMealPlanPortion',
      payload: {
        expectedVersion: afterUnavailable.mealPlans.length,
        idempotencyKey: 'structured-resize-after-provider-0001',
        payload: { businessDate: RESIZE_DATE, slot: 'lunch', multiplier }
      }
    });
    expect(resize).toMatchObject({
      success: true, data: { kind: 'meal_plan_updated', version: { version: 2 } }
    });
  });

  it('isolates messages, summaries, pending turns, receipts, and planning versions by identity', async () => {
    const harness = createHarness();
    const userA = 'assistant-isolation-a';
    const userB = 'assistant-isolation-b';
    await prepareUser(harness, userA);

    const held = sendAssistant(
      harness, userA, 0, 'assistant-isolation-hold-0001', '测试隔离中的挂起请求'
    );
    await harness.model.waitForHold();
    const [pendingA, pendingB] = await Promise.all([
      harness.assistantHandler({ action: 'getAssistantConversation' }, { userId: userA }),
      harness.assistantHandler({ action: 'getAssistantConversation' }, { userId: userB })
    ]);
    expect(pendingA).toMatchObject({
      success: true,
      data: {
        kind: 'assistant_conversation',
        pendingTurn: { idempotencyKey: 'assistant-isolation-hold-0001' }
      }
    });
    expect(pendingB).toMatchObject({
      success: true,
      data: { kind: 'assistant_conversation', conversationVersion: 0, pendingTurn: null }
    });

    const [planningA, planningB] = await Promise.all([
      callPlanning(harness, userA, { action: 'getCurrentContext' }),
      callPlanning(harness, userB, { action: 'getCurrentContext' })
    ]);
    expect(planningA).toMatchObject({
      success: true,
      data: { kind: 'current_context', latestVersions: { trainingPlan: 1, mealPlan: 1 } }
    });
    expect(planningB).toMatchObject({
      success: true,
      data: { kind: 'current_context', latestVersions: { trainingPlan: 0, mealPlan: 0 } }
    });

    harness.model.releaseHold();
    await held;
    await sendAssistant(
      harness,
      userB,
      0,
      'assistant-isolation-b-0001',
      `把 ${SOURCE_DATE} 的训练移到另一日`
    );
    const [conversationA, conversationB, stateA, stateB] = await Promise.all([
      harness.assistantHandler({ action: 'getAssistantConversation' }, { userId: userA }),
      harness.assistantHandler({ action: 'getAssistantConversation' }, { userId: userB }),
      harness.repository.read(userA),
      harness.repository.read(userB)
    ]);
    expect(JSON.stringify(conversationA)).toContain('测试隔离中的挂起请求');
    expect(JSON.stringify(conversationA)).not.toContain('移到另一日');
    expect(JSON.stringify(conversationB)).toContain('移到另一日');
    expect(JSON.stringify(conversationB)).not.toContain('测试隔离中的挂起请求');
    expect(JSON.stringify({ conversationA, conversationB })).not.toMatch(
      /recentReceipts|summary|trainingPlanVersion|mealPlanVersion/
    );
    expect(stateA.assistantConversation.summary).toMatchObject({
      trainingPlanVersion: 1, mealPlanVersion: 1
    });
    expect(stateB.assistantConversation.summary).toMatchObject({
      trainingPlanVersion: 0, mealPlanVersion: 0
    });
    expect(stateA.assistantConversation.recentReceipts).toHaveLength(1);
    expect(stateB.assistantConversation.recentReceipts).toHaveLength(1);
    expect(JSON.stringify(stateA.assistantConversation)).not.toContain('移到另一日');
    expect(JSON.stringify(stateB.assistantConversation)).not.toContain('挂起请求');

    await expect(harness.assistantHandler({ action: 'getAssistantConversation' }))
      .resolves.toMatchObject({ success: false, error: { code: 'unauthenticated' } });
  });
});
