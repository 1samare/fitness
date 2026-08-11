import { describe, expect, test } from 'vitest';
import {
  createMealPlanRecalculationService,
  type MealPlanRecalculationServiceDependencies
} from '../../packages/application/src/index';
import type { PlanningApiResponse } from '../../packages/contracts/src/index';
import type {
  MealPlanVersion,
  NutrientValues,
  NutritionDataSnapshot,
  PlanningAggregateState
} from '../../packages/domain/src/index';
import {
  TEST_DAILY_MENU_CATALOG,
  TEST_DAILY_MENU_TEMPLATES,
  TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS,
  TEST_NUTRITION_SNAPSHOTS,
  TEST_RECIPE_TEMPLATES
} from '../../data/nutrition-fixtures/src/index';
import { InMemoryPlanningRepository } from '../../packages/persistence/src/index';
import {
  ReviewedNutritionCache,
  StaticDailyMenuCatalogProvider,
  StaticRecipeTemplateProvider
} from '../../packages/providers/src/index';
import {
  createPlanningApiHandler,
  type TrustedRequestContext
} from '../../cloudfunctions/planning-api/src/handler';

const USER: TrustedRequestContext = { userId: 'user-a' };
const WEEK_START = '2026-08-17';
const TODAY = '2026-08-19';
const MOVED_FROM = '2026-08-21';
const MOVED_TO = '2026-08-22';
const INITIAL_NOW = '2026-08-10T00:00:00.000Z';
const TODAY_NOW = '2026-08-19T04:00:00.000Z';
const REPLACEMENT_RECIPE_ID = 'recipe-version-fixture-day-2-dinner-v1';
const NUTRIENT_KEYS = [
  'energyKcal',
  'proteinG',
  'fatG',
  'carbohydrateG',
  'fiberG',
  'saturatedFatG',
  'addedSugarG'
] as const satisfies readonly (keyof NutrientValues)[];

const BALANCED_SNAPSHOTS: readonly NutritionDataSnapshot[] =
  TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS;

type SuccessData = Extract<PlanningApiResponse, { readonly success: true }>['data'];

interface Harness {
  readonly handler: ReturnType<typeof createPlanningApiHandler>;
  readonly repository: InMemoryPlanningRepository;
  readonly setNow: (value: string) => void;
  readonly setProviders: (
    value: MealPlanRecalculationServiceDependencies['providers']
  ) => void;
}

interface FlowSignature {
  readonly latestVersions: Extract<
    SuccessData,
    { readonly kind: 'current_context' }
  >['latestVersions'];
  readonly completionEventId: string;
  readonly completionEnergyTargetId: string;
  readonly completionNutritionTargetId: string;
  readonly mealPlanId: string;
  readonly mealContent: readonly MealPlanVersion['days'][number][];
  readonly persistedCounts: Readonly<Record<string, number>>;
}

function fixtureProviders(): MealPlanRecalculationServiceDependencies['providers'] {
  return {
    nutrition: new ReviewedNutritionCache({ mode: 'test', snapshots: BALANCED_SNAPSHOTS }),
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
  };
}

function createHarness(
  initialProviders: MealPlanRecalculationServiceDependencies['providers'] = fixtureProviders()
): Harness {
  const repository = new InMemoryPlanningRepository();
  let sequence = 0;
  let instant = INITIAL_NOW;
  let activeProviders = initialProviders;
  const service = createMealPlanRecalculationService({
    repository,
    now: () => instant,
    nextId: (prefix) => `${prefix}-${String(++sequence)}`,
    providers: {
      nutrition: {
        getSnapshot: (id) => activeProviders.nutrition.getSnapshot(id),
        resolveCanonicalName: (name) => activeProviders.nutrition.resolveCanonicalName(name)
      },
      recipes: {
        getByVersionId: (id) => activeProviders.recipes.getByVersionId(id)
      },
      menus: {
        getActiveCatalog: () => activeProviders.menus.getActiveCatalog(),
        getMenuByVersionId: (id) => activeProviders.menus.getMenuByVersionId(id)
      },
      get allowTestFixtures() {
        return activeProviders.allowTestFixtures;
      }
    }
  });
  return {
    handler: createPlanningApiHandler(service),
    repository,
    setNow(value) {
      instant = value;
    },
    setProviders(value) {
      activeProviders = value;
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

async function call(harness: Harness, request: unknown): Promise<PlanningApiResponse> {
  const response = await harness.handler(request, USER);
  expect(JSON.stringify(response)).not.toContain('userId');
  expect(JSON.stringify(response)).not.toContain(USER.userId);
  return response;
}

function setupRequest(input: {
  readonly idempotencyKey: string;
  readonly allergens?: readonly string[];
  readonly heightCm?: number;
  readonly weightKg?: number;
  readonly sexCode?: 0 | 1;
  readonly goal?: 'maintain' | 'fat_loss' | 'muscle_gain';
  readonly sessions?: readonly {
    readonly businessDate: string;
    readonly sessionCode: string;
    readonly durationMinutes: number;
  }[];
}) {
  return {
    action: 'completePlanningSetup',
    payload: {
      expectedVersions: { bodyProfile: 0, goal: 0, trainingPlan: 0 },
      idempotencyKey: input.idempotencyKey,
      bodyProfile: {
        ageYears: 30,
        sexCode: input.sexCode ?? 0,
        heightCm: input.heightCm ?? 175,
        weightKg: input.weightKg ?? 60,
        healthScopeConfirmed: true,
        nonTrainingActivity: 'light',
        allergens: input.allergens ?? [],
        avoidFoods: [],
        dietPreferences: [],
        businessTimezone: 'Asia/Shanghai'
      },
      goal: {
        goal: input.goal ?? 'muscle_gain',
        effectiveDate: '2026-08-10',
        targetDate: '2026-10-30'
      },
      trainingPlan: {
        weekStartDate: WEEK_START,
        businessTimezone: 'Asia/Shanghai',
        sessions: input.sessions ?? []
      }
    }
  } as const;
}

function inventoryRequest(
  idempotencyKey: string,
  availableGrams: number
) {
  return {
    action: 'saveInventory',
    payload: {
      expectedVersion: 0,
      idempotencyKey,
      payload: {
        items: TEST_NUTRITION_SNAPSHOTS.map((snapshot) => ({
          name: snapshot.canonicalNameZh,
          availableGrams
        }))
      }
    }
  } as const;
}

function generateRequest(idempotencyKey: string) {
  return {
    action: 'generateWeeklyMealPlan',
    payload: {
      expectedVersion: 0,
      idempotencyKey,
      payload: { weekStartDate: WEEK_START }
    }
  } as const;
}

function roundHalfUpOneDecimal(value: number): number {
  return Math.floor((value + Number.EPSILON) * 10 + 0.5) / 10;
}

function independentlyRecomputedTotals(
  day: MealPlanVersion['days'][number],
  snapshots: readonly NutritionDataSnapshot[]
): NutrientValues {
  expect(day.ingredientAmounts.length).toBeGreaterThan(0);
  expect(snapshots).toHaveLength(28);
  const byFoodId = new Map(snapshots.map((snapshot) => [snapshot.foodId, snapshot]));
  const raw: Record<(typeof NUTRIENT_KEYS)[number], number> = {
    energyKcal: 0,
    proteinG: 0,
    fatG: 0,
    carbohydrateG: 0,
    fiberG: 0,
    saturatedFatG: 0,
    addedSugarG: 0
  };
  for (const ingredient of day.ingredientAmounts) {
    const snapshot = byFoodId.get(ingredient.foodId);
    if (snapshot === undefined) {
      throw new Error(`Missing independent snapshot for ${ingredient.foodId}`);
    }
    for (const key of NUTRIENT_KEYS) {
      raw[key] += roundHalfUpOneDecimal(
        snapshot.nutrientsPer100g[key] * ingredient.grams / 100
      );
    }
  }
  return {
    energyKcal: roundHalfUpOneDecimal(raw.energyKcal),
    proteinG: roundHalfUpOneDecimal(raw.proteinG),
    fatG: roundHalfUpOneDecimal(raw.fatG),
    carbohydrateG: roundHalfUpOneDecimal(raw.carbohydrateG),
    fiberG: roundHalfUpOneDecimal(raw.fiberG),
    saturatedFatG: roundHalfUpOneDecimal(raw.saturatedFatG),
    addedSugarG: roundHalfUpOneDecimal(raw.addedSugarG)
  };
}

function stateCounts(state: PlanningAggregateState): Readonly<Record<string, number>> {
  return {
    bodyProfile: state.bodyProfiles.length,
    goal: state.goals.length,
    trainingPlan: state.trainingPlans.length,
    dailyEnergyTarget: state.dailyEnergyTargets.length,
    dailyNutritionTarget: state.dailyNutritionTargets.length,
    inventory: state.inventories.length,
    mealPlan: state.mealPlans.length,
    mealPlanTargetDiff: state.mealPlanTargetDiffs.length,
    mealPlanDecision: state.mealPlanDecisions.length,
    trainingCompletion: state.trainingCompletionEvents.length,
    recalculationJob: state.recalculationJobs.length,
    outboxEvent: state.outboxEvents.length,
    idempotencyRecord: state.idempotencyRecords.length
  };
}

async function currentContext(harness: Harness) {
  return requireData(await call(harness, { action: 'getCurrentContext' }), 'current_context');
}

async function saveFullInventory(harness: Harness, key: string, grams = 50_000): Promise<void> {
  const saved = requireData(
    await call(harness, inventoryRequest(key, grams)),
    'inventory_saved'
  );
  expect(saved.version.items).toHaveLength(28);
  expect(new Set(saved.version.items.map((item) => item.foodId)).size).toBe(28);
}

async function runCompleteFlow(): Promise<FlowSignature> {
  const harness = createHarness();

  // 1. The public setup command creates a complete future week and seven target dates.
  const initialSessions = [
    { businessDate: TODAY, sessionCode: '02054', durationMinutes: 60 },
    { businessDate: MOVED_FROM, sessionCode: '02054', durationMinutes: 60 }
  ] as const;
  const setup = requireData(
    await call(harness, setupRequest({
      idempotencyKey: 'e2e-setup-001',
      sessions: initialSessions
    })),
    'planning_setup_completed'
  );
  expect(setup.affectedDates).toEqual([
    '2026-08-17',
    '2026-08-18',
    '2026-08-19',
    '2026-08-20',
    '2026-08-21',
    '2026-08-22',
    '2026-08-23'
  ]);
  expect(setup.dailyNutritionTargets).toHaveLength(7);

  // 2. Ordinary Chinese fixture names resolve through the public provider boundary.
  expect(TEST_NUTRITION_SNAPSHOTS).toHaveLength(28);
  const resolvedFoodIds: string[] = [];
  for (const snapshot of TEST_NUTRITION_SNAPSHOTS) {
    const resolved = requireData(
      await call(harness, {
        action: 'resolveFoodName',
        payload: { name: snapshot.canonicalNameZh }
      }),
      'food_name_resolved'
    );
    expect(resolved.resolution).toEqual({
      foodId: snapshot.foodId,
      canonicalNameZh: snapshot.canonicalNameZh,
      nutritionSnapshotId: snapshot.id
    });
    if (resolved.resolution !== null) resolvedFoodIds.push(resolved.resolution.foodId);
  }
  expect(resolvedFoodIds).toHaveLength(28);
  expect(new Set(resolvedFoodIds).size).toBe(28);
  await saveFullInventory(harness, 'e2e-inventory-001');

  // 3. A complete plan has seven unique dates and every total is independently reproducible.
  const generated = requireData(
    await call(harness, generateRequest('e2e-generate-001')),
    'weekly_meal_plan_generated'
  ).version;
  expect(generated.days).toHaveLength(7);
  expect(new Set(generated.days.map((day) => day.businessDate)).size).toBe(7);
  for (const day of generated.days) {
    expect(day.ingredientAmounts.length).toBeGreaterThan(0);
    expect(day.nutritionTotals).toEqual(
      independentlyRecomputedTotals(day, BALANCED_SNAPSHOTS)
    );
  }
  const historicalState = await harness.repository.read(USER.userId);
  const pastSnapshotBeforeChanges = structuredClone({
    bodyProfiles: historicalState.bodyProfiles,
    goals: historicalState.goals,
    trainingPlans: historicalState.trainingPlans,
    dailyEnergyTargets: historicalState.dailyEnergyTargets,
    dailyNutritionTargets: historicalState.dailyNutritionTargets,
    inventories: historicalState.inventories,
    mealPlans: historicalState.mealPlans
  });

  // 4. One explicit lock and one structured edit create two protected days.
  const locked = requireData(
    await call(harness, {
      action: 'setMealPlanDayLock',
      payload: {
        expectedVersion: 1,
        idempotencyKey: 'e2e-lock-001',
        payload: { businessDate: MOVED_FROM, locked: true }
      }
    }),
    'meal_plan_updated'
  ).version;
  expect(locked.days.find((day) => day.businessDate === MOVED_FROM)).toMatchObject({
    locked: true,
    manuallyModified: false
  });
  const manuallyEdited = requireData(
    await call(harness, {
      action: 'updateMealPlanDay',
      payload: {
        expectedVersion: 2,
        idempotencyKey: 'e2e-manual-edit-001',
        payload: {
          businessDate: MOVED_TO,
          slot: 'dinner',
          recipeTemplateVersionId: REPLACEMENT_RECIPE_ID
        }
      }
    }),
    'meal_plan_updated'
  ).version;
  expect(manuallyEdited.days.find((day) => day.businessDate === MOVED_TO)).toMatchObject({
    locked: true,
    manuallyModified: true
  });
  const protectedActiveBeforeMove = structuredClone(manuallyEdited);

  // 5. Moving Friday to Saturday affects exactly those protected dates and preserves all others.
  const moveCommand = {
    action: 'saveTrainingPlan',
    payload: {
      expectedVersion: 1,
      idempotencyKey: 'e2e-training-move-001',
      payload: {
        weekStartDate: WEEK_START,
        businessTimezone: 'Asia/Shanghai',
        sessions: [
          { businessDate: TODAY, sessionCode: '02054', durationMinutes: 60 },
          { businessDate: MOVED_TO, sessionCode: '02054', durationMinutes: 60 }
        ]
      }
    }
  } as const;
  const moved = requireData(await call(harness, moveCommand), 'training_plan_saved');
  expect(moved.dailyEnergyTargets).toHaveLength(2);
  expect(moved.dailyNutritionTargets).toHaveLength(2);
  expect(moved.dailyEnergyTargets.map((target) => target.businessDate)).toEqual([
    MOVED_FROM,
    MOVED_TO
  ]);
  const afterMove = await currentContext(harness);
  expect(afterMove.mealPlan?.id).toBe(protectedActiveBeforeMove.id);
  expect(afterMove.mealPlanStale).toBe(true);
  expect(afterMove.pendingMealPlanCandidate).not.toBeNull();
  expect(afterMove.pendingMealPlanTargetDiffs).toHaveLength(2);
  expect(afterMove.pendingMealPlanTargetDiffs.map((diff) => diff.businessDate)).toEqual([
    MOVED_FROM,
    MOVED_TO
  ]);
  const movedCandidate = afterMove.pendingMealPlanCandidate;
  if (movedCandidate === null) throw new Error('Expected move candidate');
  const affectedDates = [MOVED_FROM, MOVED_TO];
  expect(movedCandidate.days.filter((day) => (
    affectedDates.includes(day.businessDate)
  ))).toHaveLength(affectedDates.length);
  const unaffectedDates = protectedActiveBeforeMove.days
    .map((day) => day.businessDate)
    .filter((date) => !affectedDates.includes(date));
  expect(unaffectedDates).toHaveLength(5);
  for (const date of unaffectedDates) {
    expect(movedCandidate.days.find((day) => day.businessDate === date)).toEqual(
      protectedActiveBeforeMove.days.find((day) => day.businessDate === date)
    );
  }

  // 6. Keeping the old plan acknowledges the candidate but leaves stale activity untouched.
  const keepCommand = {
    action: 'decideMealPlanCandidate',
    payload: {
      expectedVersion: 0,
      idempotencyKey: 'e2e-keep-001',
      payload: {
        candidateMealPlanVersionId: movedCandidate.id,
        decision: 'keep_existing'
      }
    }
  } as const;
  const kept = requireData(await call(harness, keepCommand), 'meal_plan_candidate_decided');
  expect(kept.decision).toMatchObject({
    decision: 'keep_existing',
    activatedMealPlanVersionId: null
  });
  const afterKeep = await currentContext(harness);
  expect(afterKeep.mealPlan?.id).toBe(protectedActiveBeforeMove.id);
  expect(afterKeep.mealPlanStale).toBe(true);
  expect(afterKeep.pendingMealPlanCandidate).toBeNull();
  expect(afterKeep.pendingMealPlanTargetDiffs).toHaveLength(0);

  // 7. A later duration change creates another protected candidate; overwrite activates only a full successor.
  const durationCommand = {
    action: 'saveTrainingPlan',
    payload: {
      expectedVersion: 2,
      idempotencyKey: 'e2e-training-duration-001',
      payload: {
        weekStartDate: WEEK_START,
        businessTimezone: 'Asia/Shanghai',
        sessions: [
          { businessDate: TODAY, sessionCode: '02054', durationMinutes: 60 },
          { businessDate: MOVED_TO, sessionCode: '02054', durationMinutes: 30 }
        ]
      }
    }
  } as const;
  const durationChanged = requireData(
    await call(harness, durationCommand),
    'training_plan_saved'
  );
  expect(durationChanged.dailyNutritionTargets).toHaveLength(1);
  expect(durationChanged.dailyNutritionTargets[0]?.businessDate).toBe(MOVED_TO);
  const beforeOverwrite = await currentContext(harness);
  expect(beforeOverwrite.mealPlan?.id).toBe(protectedActiveBeforeMove.id);
  expect(beforeOverwrite.pendingMealPlanCandidate).not.toBeNull();
  expect(beforeOverwrite.pendingMealPlanTargetDiffs).toHaveLength(1);
  expect(beforeOverwrite.pendingMealPlanTargetDiffs[0]?.businessDate).toBe(MOVED_TO);
  const overwriteCandidate = beforeOverwrite.pendingMealPlanCandidate;
  if (overwriteCandidate === null) throw new Error('Expected duration-change candidate');
  const overwriteCommand = {
    action: 'decideMealPlanCandidate',
    payload: {
      expectedVersion: 1,
      idempotencyKey: 'e2e-overwrite-001',
      payload: {
        candidateMealPlanVersionId: overwriteCandidate.id,
        decision: 'overwrite_locked'
      }
    }
  } as const;
  const overwritten = requireData(
    await call(harness, overwriteCommand),
    'meal_plan_candidate_decided'
  );
  expect(overwritten.activatedMealPlan).not.toBeNull();
  expect(overwritten.activatedMealPlan?.days).toHaveLength(7);
  expect(overwritten.activatedMealPlan).toMatchObject({
    readiness: 'complete',
    supersedesVersionId: overwriteCandidate.id
  });
  expect(overwritten.recalculationJob).toMatchObject({
    status: 'completed',
    activatedMealPlanVersionId: overwritten.activatedMealPlan?.id
  });
  const afterOverwrite = await currentContext(harness);
  expect(afterOverwrite.mealPlan?.id).toBe(overwritten.activatedMealPlan?.id);
  expect(afterOverwrite.mealPlanStale).toBe(true);
  expect(afterOverwrite.pendingMealPlanCandidate).toBeNull();

  // 8. Fewer minutes today add exactly one event-linked energy/meal target pair for today.
  harness.setNow(TODAY_NOW);
  const completionCommand = {
    action: 'recordTrainingCompletion',
    payload: {
      expectedVersion: 0,
      idempotencyKey: 'e2e-completion-001',
      payload: { businessDate: TODAY, completedDurationMinutes: 30 }
    }
  } as const;
  const completed = requireData(
    await call(harness, completionCommand),
    'training_completion_recorded'
  );
  expect(completed.event).toMatchObject({
    businessDate: TODAY,
    completedDurationMinutes: 30
  });
  expect(completed.dailyEnergyTargets).toHaveLength(1);
  expect(completed.dailyNutritionTargets).toHaveLength(1);
  expect(completed.dailyEnergyTargets[0]).toMatchObject({
    businessDate: TODAY,
    trainingCompletionEventId: completed.event.id
  });
  expect(completed.dailyNutritionTargets[0]).toMatchObject({
    businessDate: TODAY,
    trainingCompletionEventId: completed.event.id,
    dailyEnergyTargetVersionId: completed.dailyEnergyTargets[0]?.id
  });
  const afterCompletionState = await harness.repository.read(USER.userId);
  const completionEnergyTargets = afterCompletionState.dailyEnergyTargets.filter((target) => (
    target.trainingCompletionEventId === completed.event.id
  ));
  const completionNutritionTargets = afterCompletionState.dailyNutritionTargets.filter((target) => (
    target.trainingCompletionEventId === completed.event.id
  ));
  expect(completionEnergyTargets).toHaveLength(1);
  expect(completionNutritionTargets).toHaveLength(1);
  expect(completionEnergyTargets[0]?.businessDate).toBe(TODAY);
  expect(completionNutritionTargets[0]?.businessDate).toBe(TODAY);

  // 9. Public command replays reuse the event/versions and cannot grow any version count.
  const beforeReplay = await currentContext(harness);
  const persistedBeforeReplay = await harness.repository.read(USER.userId);
  const replayedMove = requireData(await call(harness, moveCommand), 'training_plan_saved');
  expect(replayedMove.trainingPlan.id).toBe(moved.trainingPlan.id);
  const replayedDuration = requireData(
    await call(harness, durationCommand),
    'training_plan_saved'
  );
  expect(replayedDuration.trainingPlan.id).toBe(durationChanged.trainingPlan.id);
  const replayedOverwrite = requireData(
    await call(harness, overwriteCommand),
    'meal_plan_candidate_decided'
  );
  expect(replayedOverwrite.decision.id).toBe(overwritten.decision.id);
  const replayedCompletion = requireData(
    await call(harness, completionCommand),
    'training_completion_recorded'
  );
  expect(replayedCompletion.event.id).toBe(completed.event.id);
  const afterReplay = await currentContext(harness);
  const persistedAfterReplay = await harness.repository.read(USER.userId);
  expect(afterReplay.latestVersions).toEqual(beforeReplay.latestVersions);
  expect(stateCounts(persistedAfterReplay)).toEqual(stateCounts(persistedBeforeReplay));

  // Historical versions are append-only even after moves, decisions, completion, and replays.
  const pastSnapshot = {
    bodyProfiles: persistedAfterReplay.bodyProfiles.slice(0, 1),
    goals: persistedAfterReplay.goals.slice(0, 1),
    trainingPlans: persistedAfterReplay.trainingPlans.slice(0, 1),
    dailyEnergyTargets: persistedAfterReplay.dailyEnergyTargets.slice(0, 7),
    dailyNutritionTargets: persistedAfterReplay.dailyNutritionTargets.slice(0, 7),
    inventories: persistedAfterReplay.inventories.slice(0, 1),
    mealPlans: persistedAfterReplay.mealPlans.slice(0, 1)
  };
  expect(pastSnapshot).toEqual(structuredClone(pastSnapshotBeforeChanges));

  const finalPlan = afterReplay.mealPlan;
  if (finalPlan === null) throw new Error('Expected final active plan');
  const completionEnergyTarget = completed.dailyEnergyTargets[0];
  const completionNutritionTarget = completed.dailyNutritionTargets[0];
  if (completionEnergyTarget === undefined || completionNutritionTarget === undefined) {
    throw new Error('Expected completion-linked targets');
  }
  return {
    latestVersions: afterReplay.latestVersions,
    completionEventId: completed.event.id,
    completionEnergyTargetId: completionEnergyTarget.id,
    completionNutritionTargetId: completionNutritionTarget.id,
    mealPlanId: finalPlan.id,
    mealContent: finalPlan.days,
    persistedCounts: stateCounts(persistedAfterReplay)
  };
}

async function assertGenerationFailsWithoutPartialPlan(input: {
  readonly key: string;
  readonly harness?: Harness;
  readonly setup: ReturnType<typeof setupRequest>;
  readonly inventoryGrams?: number;
  readonly beforeGenerate?: (harness: Harness) => void;
  readonly expectedCode: 'provider_unavailable' | 'nutrition_constraints_infeasible';
}): Promise<void> {
  const harness = input.harness ?? createHarness();
  requireData(await call(harness, input.setup), 'planning_setup_completed');
  await saveFullInventory(
    harness,
    `${input.key}-inventory`,
    input.inventoryGrams ?? 50_000
  );
  input.beforeGenerate?.(harness);
  const before = await harness.repository.read(USER.userId);
  expect(before.mealPlans).toHaveLength(0);
  expect(before.activeMealPlanVersionId).toBeNull();

  const result = await call(harness, generateRequest(`${input.key}-generate`));

  expect(result).toMatchObject({ success: false, error: { code: input.expectedCode } });
  const after = await harness.repository.read(USER.userId);
  expect(after.mealPlans).toHaveLength(0);
  expect(after.activeMealPlanVersionId).toBeNull();
  expect(after.dailyEnergyTargets).toEqual(before.dailyEnergyTargets);
  expect(after.dailyNutritionTargets).toEqual(before.dailyNutritionTargets);
  const context = await currentContext(harness);
  expect(context.mealPlan).toBeNull();
  expect(context.pendingMealPlanCandidate).toBeNull();
  expect(context.latestVersions.mealPlan).toBe(0);
}

describe('weekly meal loop end-to-end acceptance', () => {
  test('executes the exact public-handler loop twice with deterministic ids, content, and replay', async () => {
    const first = await runCompleteFlow();
    const second = await runCompleteFlow();

    expect(first.latestVersions.mealPlan).toBeGreaterThan(0);
    expect(first.mealContent).toHaveLength(7);
    expect(first.persistedCounts.mealPlan).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });

  test('fails closed for allergens, inventory, source, provider, and infeasible targets', async () => {
    await assertGenerationFailsWithoutPartialPlan({
      key: 'allergen',
      setup: setupRequest({
        idempotencyKey: 'allergen-setup',
        allergens: [
          '含麸质谷物',
          '大豆',
          '乳类',
          '蛋类',
          '鱼类',
          '花生',
          '坚果',
          '芝麻'
        ]
      }),
      expectedCode: 'nutrition_constraints_infeasible'
    });

    await assertGenerationFailsWithoutPartialPlan({
      key: 'inventory',
      setup: setupRequest({ idempotencyKey: 'inventory-setup' }),
      inventoryGrams: 1,
      expectedCode: 'nutrition_constraints_infeasible'
    });

    const sourceProviders = fixtureProviders();
    await assertGenerationFailsWithoutPartialPlan({
      key: 'missing-source',
      setup: setupRequest({ idempotencyKey: 'missing-source-setup' }),
      beforeGenerate(harness) {
        harness.setProviders({
          ...sourceProviders,
          nutrition: {
            resolveCanonicalName: (name) => sourceProviders.nutrition.resolveCanonicalName(name),
            async getSnapshot(id) {
              const snapshot = await sourceProviders.nutrition.getSnapshot(id);
              if (id !== BALANCED_SNAPSHOTS[0]?.id) return snapshot;
              return { ...snapshot, sourceId: '' };
            }
          }
        });
      },
      expectedCode: 'provider_unavailable'
    });

    const offlineProviders = fixtureProviders();
    await assertGenerationFailsWithoutPartialPlan({
      key: 'provider',
      setup: setupRequest({ idempotencyKey: 'provider-setup' }),
      beforeGenerate(harness) {
        harness.setProviders({
          ...offlineProviders,
          menus: {
            getActiveCatalog: () => Promise.reject(new Error('fixture provider offline')),
            getMenuByVersionId: (id) => offlineProviders.menus.getMenuByVersionId(id)
          }
        });
      },
      expectedCode: 'provider_unavailable'
    });

    await assertGenerationFailsWithoutPartialPlan({
      key: 'infeasible-target',
      setup: setupRequest({
        idempotencyKey: 'infeasible-target-setup',
        heightCm: 116,
        weightKg: 25,
        sexCode: 1,
        goal: 'maintain'
      }),
      expectedCode: 'nutrition_constraints_infeasible'
    });
  });
});
