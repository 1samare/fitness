import { describe, expect, test } from 'vitest';
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
import type {
  DailyEnergyTargetVersion,
  MealPlanDay,
  MealPlanVersion,
  NutritionDataSnapshot,
  TrainingSessionPayload
} from '@fitness/domain';
import { InMemoryPlanningRepository } from '@fitness/persistence';
import { PastFactImmutableError } from './meal-plan-editing';
import { FutureCompletionForbiddenError } from './planning-errors';
import {
  IdempotencyKeyReuseError,
  VersionConflictError,
  type PlanningRepository
} from './versioned-planning';
import {
  CandidateNotPendingError,
  analyzeMealPlanRecalculation,
  analyzeTrainingChangeAffectedDates,
  createMealPlanRecalculationService,
  type MealPlanRecalculationServiceDependencies
} from './meal-plan-recalculation';

const WEEK_START = '2026-08-17';
const NEXT_WEEK_START = '2026-08-24';
const NOW_BEFORE_WEEK = '2026-08-10T00:00:00.000Z';
const NOW_ON_WEDNESDAY = '2026-08-19T04:00:00.000Z';
const BALANCED_SNAPSHOTS: readonly NutritionDataSnapshot[] = TEST_NUTRITION_SNAPSHOTS.map(
  (snapshot) => ({
    ...snapshot,
    nutrientsPer100g: {
      energyKcal: 160,
      proteinG: 6.7,
      fatG: 4.5,
      carbohydrateG: 24,
      fiberG: 2.2,
      saturatedFatG: 0.4,
      addedSugarG: 0
    }
  })
);

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

function createHarness(options: {
  readonly providers?: MealPlanRecalculationServiceDependencies['providers'];
  readonly repository?: PlanningRepository;
} = {}) {
  const repository = options.repository ?? new InMemoryPlanningRepository();
  let sequence = 0;
  let instant = NOW_BEFORE_WEEK;
  let activeProviders = options.providers ?? fixtureProviders();
  const service = createMealPlanRecalculationService({
    repository,
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
    },
    now: () => instant,
    nextId: (prefix) => `${prefix}-${String(++sequence)}`
  });
  return {
    repository,
    service,
    setNow(value: string) {
      instant = value;
    },
    setProviders(value: MealPlanRecalculationServiceDependencies['providers']) {
      activeProviders = value;
    }
  };
}

function createControlledRepository() {
  const inner = new InMemoryPlanningRepository();
  let shouldBlockNextRead = false;
  let blockedReadObserved: Promise<void> = Promise.resolve();
  let observeBlockedRead: (() => void) | undefined;
  let releaseBlockedRead: (() => void) | undefined;
  let blockedReadGate: Promise<void> = Promise.resolve();
  let failBeforeNextTransaction = false;
  let dropAfterNextCommit = false;
  const repository: PlanningRepository = {
    async read(userId) {
      const state = await inner.read(userId);
      if (!shouldBlockNextRead) return state;
      shouldBlockNextRead = false;
      observeBlockedRead?.();
      await blockedReadGate;
      return state;
    },
    async transact(userId, operation) {
      if (failBeforeNextTransaction) {
        failBeforeNextTransaction = false;
        throw new Error('simulated retry record transaction failure');
      }
      const result = await inner.transact(userId, operation);
      if (dropAfterNextCommit) {
        dropAfterNextCommit = false;
        throw new Error('simulated response loss');
      }
      return result;
    }
  };
  return {
    inner,
    repository,
    blockNextRead() {
      shouldBlockNextRead = true;
      blockedReadObserved = new Promise<void>((resolve) => {
        observeBlockedRead = resolve;
      });
      blockedReadGate = new Promise<void>((resolve) => {
        releaseBlockedRead = resolve;
      });
    },
    waitForBlockedRead() {
      return blockedReadObserved;
    },
    releaseBlockedRead() {
      releaseBlockedRead?.();
    },
    failNextTransactionBeforeCommit() {
      failBeforeNextTransaction = true;
    },
    dropNextTransactionResponseAfterCommit() {
      dropAfterNextCommit = true;
    }
  };
}

async function prepareGeneratedPlan(
  harness: ReturnType<typeof createHarness>,
  sessions: readonly TrainingSessionPayload[] = []
): Promise<MealPlanVersion> {
  await harness.service.completePlanningSetup('user-a', {
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
      goal: 'muscle_gain',
      effectiveDate: '2026-08-10',
      targetDate: '2026-10-30'
    },
    trainingPlan: {
      weekStartDate: WEEK_START,
      businessTimezone: 'Asia/Shanghai',
      sessions
    }
  });
  await harness.service.saveInventory('user-a', {
    expectedVersion: 0,
    idempotencyKey: 'inventory-save-001',
    payload: {
      items: BALANCED_SNAPSHOTS.map((snapshot) => ({
        name: snapshot.canonicalNameZh,
        availableGrams: 50_000
      }))
    }
  });
  return harness.service.generateWeeklyMealPlan('user-a', {
    expectedVersion: 0,
    idempotencyKey: 'meal-generate-001',
    payload: { weekStartDate: WEEK_START }
  });
}

async function prepareConsecutivePendingCandidates(
  harness: ReturnType<typeof createHarness>
) {
  await prepareGeneratedPlan(harness);
  const active = await harness.service.setMealPlanDayLock('user-a', {
    expectedVersion: 1,
    idempotencyKey: 'meal-lock-consecutive-candidates',
    payload: { businessDate: '2026-08-20', locked: true }
  });
  const first = await harness.service.saveTrainingPlan('user-a', {
    expectedVersion: 1,
    idempotencyKey: 'training-consecutive-candidate-a',
    payload: {
      weekStartDate: WEEK_START,
      businessTimezone: 'Asia/Shanghai',
      sessions: [{
        businessDate: '2026-08-20',
        sessionCode: '02054',
        durationMinutes: 60
      }]
    }
  });
  const second = await harness.service.saveTrainingPlan('user-a', {
    expectedVersion: 2,
    idempotencyKey: 'training-consecutive-candidate-b',
    payload: {
      weekStartDate: WEEK_START,
      businessTimezone: 'Asia/Shanghai',
      sessions: [{
        businessDate: '2026-08-20',
        sessionCode: '02054',
        durationMinutes: 30
      }]
    }
  });
  if (first.candidateMealPlan === null || second.candidateMealPlan === null) {
    throw new Error('Expected two pending candidates');
  }
  return {
    active,
    first,
    second,
    firstCandidate: first.candidateMealPlan,
    secondCandidate: second.candidateMealPlan
  };
}

function sampleDay(input: {
  readonly businessDate: string;
  readonly targetId: string;
  readonly locked?: boolean;
  readonly manuallyModified?: boolean;
}): MealPlanDay {
  return {
    businessDate: input.businessDate,
    dailyNutritionTargetVersionId: input.targetId,
    dailyMenuTemplateVersionId: 'menu-1',
    locked: input.locked ?? false,
    manuallyModified: input.manuallyModified ?? false,
    meals: [{
      slot: 'breakfast',
      recipeTemplateVersionId: 'recipe-1',
      servingMultiplier: 1
    }],
    ingredientAmounts: [{ foodId: 'food-1', grams: 100 }],
    nutritionTotals: {
      energyKcal: 100,
      proteinG: 10,
      fatG: 2,
      carbohydrateG: 12,
      fiberG: 3,
      saturatedFatG: 0.5,
      addedSugarG: 0
    },
    nutritionSourceSnapshotIds: ['snapshot-1']
  };
}

describe('pure meal-plan recalculation analysis', () => {
  test('marks both future dates for a moved session and excludes a changed past date', () => {
    const previous = [
      { businessDate: '2026-08-17', sessionCode: '02054', durationMinutes: 30 },
      { businessDate: '2026-08-19', sessionCode: '02054', durationMinutes: 60 }
    ];
    const next = [
      { businessDate: '2026-08-17', sessionCode: '02054', durationMinutes: 45 },
      { businessDate: '2026-08-20', sessionCode: '02054', durationMinutes: 60 }
    ];

    expect(analyzeTrainingChangeAffectedDates({
      previousSessions: previous,
      nextSessions: next,
      weekDates: ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20'],
      businessToday: '2026-08-18'
    })).toEqual(['2026-08-19', '2026-08-20']);
  });

  test('marks the original future date for cancellation and one date for a duration change', () => {
    const session = {
      businessDate: '2026-08-20',
      sessionCode: '02054',
      durationMinutes: 60
    };
    expect(analyzeTrainingChangeAffectedDates({
      previousSessions: [session],
      nextSessions: [],
      weekDates: ['2026-08-20'],
      businessToday: '2026-08-18'
    })).toEqual(['2026-08-20']);
    expect(analyzeTrainingChangeAffectedDates({
      previousSessions: [session],
      nextSessions: [{ ...session, durationMinutes: 30 }],
      weekDates: ['2026-08-20'],
      businessToday: '2026-08-18'
    })).toEqual(['2026-08-20']);
  });

  test('preserves unaffected objects, regenerates unlocked days, and emits exact protected diffs', () => {
    const unaffected = sampleDay({ businessDate: '2026-08-19', targetId: 'nutrition-old-19' });
    const protectedDay = sampleDay({
      businessDate: '2026-08-20',
      targetId: 'nutrition-old-20',
      locked: true
    });
    const unlocked = sampleDay({ businessDate: '2026-08-21', targetId: 'nutrition-old-21' });

    const result = analyzeMealPlanRecalculation({
      previousDays: [unaffected, protectedDay, unlocked],
      affectedDates: ['2026-08-20', '2026-08-21'],
      proposedTargetVersionIdsByDate: new Map([
        ['2026-08-20', 'nutrition-new-20'],
        ['2026-08-21', 'nutrition-new-21']
      ])
    });

    expect(result.fixedDays).toHaveLength(2);
    expect(result.fixedDays[0]).toBe(unaffected);
    expect(result.fixedDays[0]).toEqual(unaffected);
    expect(result.generationDates).toEqual(['2026-08-21']);
    expect(result.targetDiffs).toEqual([{
      businessDate: '2026-08-20',
      previousNutritionTargetVersionId: 'nutrition-old-20',
      proposedNutritionTargetVersionId: 'nutrition-new-20',
      reason: 'locked_or_manually_modified'
    }]);
    expect(result.fixedDays[1]).toEqual({
      ...protectedDay,
      dailyNutritionTargetVersionId: 'nutrition-new-20'
    });
  });
});

describe('training-change recalculation lifecycle', () => {
  test('moves one session across two dates without changing weekly training energy or unrelated days', async () => {
    const harness = createHarness();
    const previous = await prepareGeneratedPlan(harness, [{
      businessDate: '2026-08-19',
      sessionCode: '02054',
      durationMinutes: 60
    }]);
    const beforeContext = await harness.service.getCurrentContext('user-a');

    const saved = await harness.service.saveTrainingPlan('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'training-move-001',
      payload: {
        weekStartDate: WEEK_START,
        businessTimezone: 'Asia/Shanghai',
        sessions: [{
          businessDate: '2026-08-20',
          sessionCode: '02054',
          durationMinutes: 60
        }]
      }
    });
    const afterContext = await harness.service.getCurrentContext('user-a');

    expect(saved.dailyEnergyTargets).toHaveLength(2);
    expect(saved.dailyNutritionTargets).toHaveLength(2);
    expect(saved.recalculationJob.affectedDates).toEqual(['2026-08-19', '2026-08-20']);
    expect(saved.activatedMealPlan?.days).toHaveLength(7);
    for (const businessDate of ['2026-08-17', '2026-08-18', '2026-08-21', '2026-08-22', '2026-08-23']) {
      expect(saved.activatedMealPlan?.days.find((day) => day.businessDate === businessDate))
        .toEqual(previous.days.find((day) => day.businessDate === businessDate));
    }
    const weeklyTraining = (targets: readonly DailyEnergyTargetVersion[]) => (
      targets.reduce((total, target) => total + (
        target.energy.kind === 'supported'
          ? target.energy.trainingNetKcal
          : 0
      ), 0)
    );
    expect(beforeContext.dailyEnergyTargets).toHaveLength(7);
    expect(afterContext.dailyEnergyTargets).toHaveLength(7);
    expect(weeklyTraining(afterContext.dailyEnergyTargets)).toBe(
      weeklyTraining(beforeContext.dailyEnergyTargets)
    );
  });

  test('cancellation and duration change each create exactly one affected target and meal day', async () => {
    for (const scenario of [
      { key: 'cancel', sessions: [] as readonly TrainingSessionPayload[], expectedNetKcal: 0 },
      {
        key: 'duration',
        sessions: [{
          businessDate: '2026-08-20',
          sessionCode: '02054',
          durationMinutes: 30
        }],
        expectedNetKcal: 79
      }
    ]) {
      const harness = createHarness();
      await prepareGeneratedPlan(harness, [{
        businessDate: '2026-08-20',
        sessionCode: '02054',
        durationMinutes: 60
      }]);
      const saved = await harness.service.saveTrainingPlan('user-a', {
        expectedVersion: 1,
        idempotencyKey: `training-${scenario.key}-001`,
        payload: {
          weekStartDate: WEEK_START,
          businessTimezone: 'Asia/Shanghai',
          sessions: scenario.sessions
        }
      });

      expect(saved.dailyEnergyTargets).toHaveLength(1);
      expect(saved.dailyNutritionTargets).toHaveLength(1);
      expect(saved.recalculationJob.affectedDates).toEqual(['2026-08-20']);
      expect(saved.activatedMealPlan).not.toBeNull();
      expect(saved.dailyEnergyTargets[0]?.energy).toMatchObject({
        kind: 'supported',
        trainingNetKcal: scenario.expectedNetKcal
      });
    }
  });

  test('saveTrainingPlan immediately consumes its pending event and activates an unlocked successor', async () => {
    const harness = createHarness();
    const previous = await prepareGeneratedPlan(harness);

    const saved = await harness.service.saveTrainingPlan('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'training-save-002',
      payload: {
        weekStartDate: WEEK_START,
        businessTimezone: 'Asia/Shanghai',
        sessions: [{
          businessDate: '2026-08-20',
          sessionCode: '02054',
          durationMinutes: 60
        }]
      }
    });
    const state = await harness.repository.read('user-a');
    const affected = saved.dailyNutritionTargets;

    expect(affected).toHaveLength(1);
    expect(saved.recalculationJob.status).toBe('completed');
    expect(saved.activatedMealPlan?.supersedesVersionId).toBe(previous.id);
    expect(state.activeMealPlanVersionId).toBe(saved.activatedMealPlan?.id);
    expect(state.outboxEvents.at(-1)?.status).toBe('pending');
    expect(state.recalculationJobs.filter(
      (job) => job.triggerEventId === saved.recalculationJob.triggerEventId
    )).toHaveLength(1);
  });

  test('generates and activates a complete new-week meal plan without reusing old-week fixed days', async () => {
    const harness = createHarness();
    await prepareGeneratedPlan(harness, [{
      businessDate: '2026-08-19',
      sessionCode: '02054',
      durationMinutes: 30
    }]);
    harness.setNow(NOW_ON_WEDNESDAY);
    await harness.service.recordTrainingCompletion('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'completion-before-next-week',
      payload: { businessDate: '2026-08-19', completedDurationMinutes: 30 }
    });
    const before = await harness.repository.read('user-a');
    const previous = before.mealPlans.find(
      (plan) => plan.id === before.activeMealPlanVersionId
    );
    if (previous === undefined) throw new Error('Expected active old-week plan');
    const oldTargets = structuredClone(before.dailyNutritionTargets);

    const saved = await harness.service.saveTrainingPlan('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'training-save-next-week',
      payload: {
        weekStartDate: NEXT_WEEK_START,
        businessTimezone: 'Asia/Shanghai',
        sessions: [{
          businessDate: '2026-08-27',
          sessionCode: '02054',
          durationMinutes: 60
        }]
      }
    });
    const after = await harness.repository.read('user-a');

    expect(saved.dailyNutritionTargets).toHaveLength(7);
    expect(saved.recalculationJob.status).toBe('completed');
    expect(saved.activatedMealPlan).toMatchObject({
      weekStartDate: NEXT_WEEK_START,
      readiness: 'complete',
      supersedesVersionId: previous.id
    });
    expect(saved.activatedMealPlan?.days).toHaveLength(7);
    expect(saved.activatedMealPlan?.days.map((day) => day.businessDate)).toEqual([
      '2026-08-24',
      '2026-08-25',
      '2026-08-26',
      '2026-08-27',
      '2026-08-28',
      '2026-08-29',
      '2026-08-30'
    ]);
    expect(after.activeMealPlanVersionId).toBe(saved.activatedMealPlan?.id);
    expect(after.mealPlans.slice(0, before.mealPlans.length)).toEqual(before.mealPlans);
    expect(after.trainingPlans.slice(0, before.trainingPlans.length)).toEqual(before.trainingPlans);
    expect(after.trainingCompletionEvents).toEqual(before.trainingCompletionEvents);
    expect(after.dailyNutritionTargets.slice(0, oldTargets.length)).toEqual(oldTargets);
  });

  test('retries a failed new-week generation without carrying old-week facts into fixed days', async () => {
    const baseProviders = fixtureProviders();
    let available = false;
    const harness = createHarness({ providers: baseProviders });
    const previous = await prepareGeneratedPlan(harness);
    const before = await harness.repository.read('user-a');
    harness.setProviders({
      ...baseProviders,
      menus: {
        getActiveCatalog: () => available
          ? baseProviders.menus.getActiveCatalog()
          : Promise.reject(new Error('offline')),
        getMenuByVersionId: (id) => baseProviders.menus.getMenuByVersionId(id)
      }
    });

    const saved = await harness.service.saveTrainingPlan('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'training-save-next-week-offline',
      payload: {
        weekStartDate: NEXT_WEEK_START,
        businessTimezone: 'Asia/Shanghai',
        sessions: []
      }
    });
    expect(saved.recalculationJob.status).toBe('failed_retryable');

    available = true;
    const failed = await harness.repository.read('user-a');
    const retried = await harness.service.retryPendingRecalculation('user-a', {
      expectedVersion: failed.recalculationJobs.length,
      idempotencyKey: 'retry-next-week-offline',
      payload: { recalculationJobId: saved.recalculationJob.id }
    });
    const after = await harness.repository.read('user-a');

    expect(retried.recalculationJob.status).toBe('completed');
    expect(retried.activatedMealPlan).toMatchObject({
      weekStartDate: NEXT_WEEK_START,
      supersedesVersionId: previous.id,
      readiness: 'complete'
    });
    expect(after.mealPlans.find((plan) => plan.id === previous.id)).toEqual(previous);
    expect(after.dailyNutritionTargets.slice(0, before.dailyNutritionTargets.length)).toEqual(
      before.dailyNutritionTargets
    );
  });

  test('locked dates create one pending candidate and exact diff without moving the active pointer', async () => {
    const harness = createHarness();
    await prepareGeneratedPlan(harness);
    const locked = await harness.service.setMealPlanDayLock('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'meal-lock-020',
      payload: { businessDate: '2026-08-20', locked: true }
    });
    const previousState = await harness.repository.read('user-a');

    const saved = await harness.service.saveTrainingPlan('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'training-save-locked',
      payload: {
        weekStartDate: WEEK_START,
        businessTimezone: 'Asia/Shanghai',
        sessions: [{
          businessDate: '2026-08-20',
          sessionCode: '02054',
          durationMinutes: 60
        }]
      }
    });
    const state = await harness.repository.read('user-a');
    const candidate = saved.candidateMealPlan;
    const diff = saved.targetDiffs[0];

    expect(candidate?.readiness).toBe('pending_confirmation');
    expect(candidate?.id).toBe(saved.recalculationJob.candidateMealPlanVersionId);
    expect(diff?.candidateMealPlanVersionId).toBe(candidate?.id);
    expect(diff?.previousNutritionTargetVersionId).not.toBe(
      diff?.proposedNutritionTargetVersionId
    );
    expect(state.activeMealPlanVersionId).toBe(locked.id);
    expect(state.activeMealPlanVersionId).toBe(previousState.activeMealPlanVersionId);
  });

  test('keep_existing records one immutable decision and completes the job while stale stays active', async () => {
    const harness = createHarness();
    await prepareGeneratedPlan(harness);
    const locked = await harness.service.setMealPlanDayLock('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'meal-lock-keep',
      payload: { businessDate: '2026-08-20', locked: true }
    });
    const saved = await harness.service.saveTrainingPlan('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'training-save-keep',
      payload: {
        weekStartDate: WEEK_START,
        businessTimezone: 'Asia/Shanghai',
        sessions: [{
          businessDate: '2026-08-20',
          sessionCode: '02054',
          durationMinutes: 60
        }]
      }
    });
    if (saved.candidateMealPlan === null) throw new Error('Expected pending candidate');

    const first = await harness.service.decideMealPlanCandidate('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'candidate-keep-001',
      payload: {
        candidateMealPlanVersionId: saved.candidateMealPlan.id,
        decision: 'keep_existing'
      }
    });
    const replay = await harness.service.decideMealPlanCandidate('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'candidate-keep-001',
      payload: {
        candidateMealPlanVersionId: saved.candidateMealPlan.id,
        decision: 'keep_existing'
      }
    });
    const state = await harness.repository.read('user-a');

    expect(replay.decision.id).toBe(first.decision.id);
    expect(first.recalculationJob.status).toBe('completed');
    expect(first.decision.activatedMealPlanVersionId).toBeNull();
    expect(state.activeMealPlanVersionId).toBe(locked.id);
    expect(state.mealPlanDecisions).toHaveLength(1);
    expect((await harness.service.getCurrentContext('user-a')).mealPlanStale).toBe(true);
  });

  test('keeping the newest candidate never resurfaces or accepts an obsolete earlier candidate', async () => {
    const harness = createHarness();
    const { firstCandidate, secondCandidate } = await prepareConsecutivePendingCandidates(harness);

    await harness.service.decideMealPlanCandidate('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'candidate-keep-consecutive-b',
      payload: {
        candidateMealPlanVersionId: secondCandidate.id,
        decision: 'keep_existing'
      }
    });
    const beforeObsoleteDecision = await harness.repository.read('user-a');

    await expect(harness.service.decideMealPlanCandidate('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'candidate-keep-consecutive-a',
      payload: {
        candidateMealPlanVersionId: firstCandidate.id,
        decision: 'keep_existing'
      }
    })).rejects.toBeInstanceOf(CandidateNotPendingError);

    expect(await harness.repository.read('user-a')).toEqual(beforeObsoleteDecision);
    expect((await harness.service.getCurrentContext('user-a')).pendingMealPlanCandidate).toBeNull();
  });

  test('rejects obsolete overwrite without state changes and still accepts the newest candidate', async () => {
    const harness = createHarness();
    const { firstCandidate, secondCandidate } = await prepareConsecutivePendingCandidates(harness);
    const beforeObsoleteDecision = await harness.repository.read('user-a');

    await expect(harness.service.decideMealPlanCandidate('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'candidate-overwrite-consecutive-a',
      payload: {
        candidateMealPlanVersionId: firstCandidate.id,
        decision: 'overwrite_locked'
      }
    })).rejects.toBeInstanceOf(CandidateNotPendingError);
    expect(await harness.repository.read('user-a')).toEqual(beforeObsoleteDecision);

    const decided = await harness.service.decideMealPlanCandidate('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'candidate-overwrite-consecutive-b',
      payload: {
        candidateMealPlanVersionId: secondCandidate.id,
        decision: 'overwrite_locked'
      }
    });
    expect(decided.activatedMealPlan?.trainingPlanVersionId).toBe(
      secondCandidate.trainingPlanVersionId
    );
    expect((await harness.repository.read('user-a')).activeMealPlanVersionId).toBe(
      decided.activatedMealPlan?.id
    );
  });

  test('overwrite_locked activates a complete direct successor only after full generation', async () => {
    const harness = createHarness();
    await prepareGeneratedPlan(harness);
    const locked = await harness.service.setMealPlanDayLock('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'meal-lock-overwrite',
      payload: { businessDate: '2026-08-20', locked: true }
    });
    const saved = await harness.service.saveTrainingPlan('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'training-save-overwrite',
      payload: {
        weekStartDate: WEEK_START,
        businessTimezone: 'Asia/Shanghai',
        sessions: [{
          businessDate: '2026-08-20',
          sessionCode: '02054',
          durationMinutes: 60
        }]
      }
    });
    if (saved.candidateMealPlan === null) throw new Error('Expected pending candidate');

    const decided = await harness.service.decideMealPlanCandidate('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'candidate-overwrite-001',
      payload: {
        candidateMealPlanVersionId: saved.candidateMealPlan.id,
        decision: 'overwrite_locked'
      }
    });
    const state = await harness.repository.read('user-a');

    expect(decided.activatedMealPlan?.readiness).toBe('complete');
    expect(decided.activatedMealPlan?.supersedesVersionId).toBe(saved.candidateMealPlan.id);
    expect(decided.recalculationJob.activatedMealPlanVersionId).toBe(
      decided.activatedMealPlan?.id
    );
    expect(state.activeMealPlanVersionId).toBe(decided.activatedMealPlan?.id);
    expect(locked.days.find((day) => day.businessDate === '2026-08-20')?.locked).toBe(true);
  });

  test('rejects overwrite for legacy diffs without changing state while keep_existing remains available', async () => {
    const harness = createHarness();
    await prepareGeneratedPlan(harness);
    await harness.service.setMealPlanDayLock('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'meal-lock-legacy-diff',
      payload: { businessDate: '2026-08-20', locked: true }
    });
    const saved = await harness.service.saveTrainingPlan('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'training-save-legacy-diff',
      payload: {
        weekStartDate: WEEK_START,
        businessTimezone: 'Asia/Shanghai',
        sessions: [{
          businessDate: '2026-08-20',
          sessionCode: '02054',
          durationMinutes: 60
        }]
      }
    });
    if (saved.candidateMealPlan === null) throw new Error('Expected pending candidate');
    await harness.repository.transact('user-a', (state) => ({
      nextState: {
        ...state,
        mealPlanTargetDiffs: state.mealPlanTargetDiffs.map((diff) => ({
          id: diff.id,
          userId: diff.userId,
          candidateMealPlanVersionId: diff.candidateMealPlanVersionId,
          businessDate: diff.businessDate,
          previousNutritionTargetVersionId: diff.previousNutritionTargetVersionId,
          proposedNutritionTargetVersionId: diff.proposedNutritionTargetVersionId,
          reason: diff.reason
        }))
      },
      result: undefined
    }));
    const beforeOverwrite = await harness.repository.read('user-a');

    await expect(harness.service.decideMealPlanCandidate('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'legacy-diff-overwrite-001',
      payload: {
        candidateMealPlanVersionId: saved.candidateMealPlan.id,
        decision: 'overwrite_locked'
      }
    })).rejects.toMatchObject({ code: 'candidate_diff_unavailable' });

    expect(await harness.repository.read('user-a')).toEqual(beforeOverwrite);
    const kept = await harness.service.decideMealPlanCandidate('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'legacy-diff-keep-001',
      payload: {
        candidateMealPlanVersionId: saved.candidateMealPlan.id,
        decision: 'keep_existing'
      }
    });
    const afterKeep = await harness.repository.read('user-a');
    expect(kept.decision.decision).toBe('keep_existing');
    expect(kept.recalculationJob.status).toBe('completed');
    expect(afterKeep.activeMealPlanVersionId).toBe(beforeOverwrite.activeMealPlanVersionId);
    expect(afterKeep.idempotencyRecords.some((record) => (
      record.key === 'legacy-diff-overwrite-001'
    ))).toBe(false);
  });

  test('retry rejects a failed overwrite candidate while the decision remains retryable', async () => {
    const baseProviders = fixtureProviders();
    const harness = createHarness({ providers: baseProviders });
    const previous = await prepareGeneratedPlan(harness);
    await harness.service.setMealPlanDayLock('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'meal-lock-overwrite-fail',
      payload: { businessDate: '2026-08-20', locked: true }
    });
    const saved = await harness.service.saveTrainingPlan('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'training-save-overwrite-fail',
      payload: {
        weekStartDate: WEEK_START,
        businessTimezone: 'Asia/Shanghai',
        sessions: [{
          businessDate: '2026-08-20',
          sessionCode: '02054',
          durationMinutes: 60
        }]
      }
    });
    if (saved.candidateMealPlan === null) throw new Error('Expected pending candidate');
    harness.setProviders({
      ...baseProviders,
      menus: {
        getActiveCatalog: () => Promise.reject(new Error('offline')),
        getMenuByVersionId: (id) => baseProviders.menus.getMenuByVersionId(id)
      }
    });

    await expect(harness.service.decideMealPlanCandidate('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'candidate-overwrite-fail',
      payload: {
        candidateMealPlanVersionId: saved.candidateMealPlan.id,
        decision: 'overwrite_locked'
      }
    })).rejects.toMatchObject({ code: 'provider_unavailable' });
    const state = await harness.repository.read('user-a');

    expect(state.mealPlanDecisions).toHaveLength(0);
    expect(state.mealPlans).toHaveLength(3);
    expect(state.activeMealPlanVersionId).not.toBe(saved.candidateMealPlan.id);
    expect(state.activeMealPlanVersionId).not.toBe(previous.id);
    expect(state.recalculationJobs.at(-1)).toMatchObject({
      id: saved.recalculationJob.id,
      status: 'failed_retryable',
      failureCode: 'provider_unavailable',
      candidateMealPlanVersionId: saved.candidateMealPlan.id,
      activatedMealPlanVersionId: null
    });
    const failedContext = await harness.service.getCurrentContext('user-a');
    expect(failedContext.pendingMealPlanCandidate?.id).toBe(saved.candidateMealPlan.id);
    expect(failedContext.retryableRecalculationJob).toBeNull();

    let providerCalls = 0;
    harness.setProviders({
      ...baseProviders,
      menus: {
        getActiveCatalog: async () => {
          providerCalls += 1;
          return baseProviders.menus.getActiveCatalog();
        },
        getMenuByVersionId: (id) => baseProviders.menus.getMenuByVersionId(id)
      }
    });
    const retryCommand = {
      expectedVersion: state.recalculationJobs.length,
      idempotencyKey: 'retry-failed-overwrite-candidate',
      payload: { recalculationJobId: saved.recalculationJob.id }
    } as const;

    await expect(
      harness.service.retryPendingRecalculation('user-a', retryCommand)
    ).rejects.toMatchObject({ code: 'candidate_not_pending' });
    await expect(
      harness.service.retryPendingRecalculation('user-a', retryCommand)
    ).rejects.toMatchObject({ code: 'candidate_not_pending' });
    await expect(harness.service.retryPendingRecalculation('user-a', {
      ...retryCommand,
      idempotencyKey: 'retry-failed-overwrite-candidate-other'
    })).rejects.toMatchObject({ code: 'candidate_not_pending' });

    const afterRejectedRetries = await harness.repository.read('user-a');
    expect(providerCalls).toBe(0);
    expect(afterRejectedRetries).toEqual(state);
    expect(afterRejectedRetries.idempotencyRecords.filter(
      (record) => record.operation === 'retryPendingRecalculation'
    )).toHaveLength(0);

    const decided = await harness.service.decideMealPlanCandidate('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'candidate-overwrite-fail',
      payload: {
        candidateMealPlanVersionId: saved.candidateMealPlan.id,
        decision: 'overwrite_locked'
      }
    });
    const afterDecisionRetry = await harness.repository.read('user-a');

    expect(providerCalls).toBeGreaterThan(0);
    expect(decided.activatedMealPlan?.readiness).toBe('complete');
    expect(decided.recalculationJob.status).toBe('completed');
    expect(afterDecisionRetry.activeMealPlanVersionId).toBe(decided.activatedMealPlan?.id);
    expect(afterDecisionRetry.mealPlanDecisions).toHaveLength(1);
  });

  test('duplicate event processing replays one job, targets, candidate, and decision lifecycle', async () => {
    const harness = createHarness();
    await prepareGeneratedPlan(harness);
    await harness.service.setMealPlanDayLock('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'meal-lock-duplicate',
      payload: { businessDate: '2026-08-20', locked: true }
    });
    const saved = await harness.service.saveTrainingPlan('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'training-save-duplicate',
      payload: {
        weekStartDate: WEEK_START,
        businessTimezone: 'Asia/Shanghai',
        sessions: [{
          businessDate: '2026-08-20',
          sessionCode: '02054',
          durationMinutes: 60
        }]
      }
    });
    const before = await harness.repository.read('user-a');
    const replay = await harness.service.processTrainingPlanChanged(
      'user-a',
      saved.recalculationJob.triggerEventId
    );
    const after = await harness.repository.read('user-a');

    expect(replay.recalculationJob.id).toBe(saved.recalculationJob.id);
    expect(after.recalculationJobs).toHaveLength(before.recalculationJobs.length);
    expect(after.dailyNutritionTargets).toHaveLength(before.dailyNutritionTargets.length);
    expect(after.mealPlans).toHaveLength(before.mealPlans.length);
    expect(after.mealPlanTargetDiffs).toHaveLength(before.mealPlanTargetDiffs.length);
  });

  test('provider failure preserves facts and active plan, then explicit retry succeeds without duplicates', async () => {
    const baseProviders = fixtureProviders();
    let available = false;
    const providers: MealPlanRecalculationServiceDependencies['providers'] = {
      ...baseProviders,
      menus: {
        getActiveCatalog: () => available
          ? baseProviders.menus.getActiveCatalog()
          : Promise.reject(new Error('offline')),
        getMenuByVersionId: (id) => baseProviders.menus.getMenuByVersionId(id)
      }
    };
    const harness = createHarness({ providers: baseProviders });
    const previous = await prepareGeneratedPlan(harness);
    harness.setProviders(providers);

    const saved = await harness.service.saveTrainingPlan('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'training-save-provider-fail',
      payload: {
        weekStartDate: WEEK_START,
        businessTimezone: 'Asia/Shanghai',
        sessions: [{
          businessDate: '2026-08-20',
          sessionCode: '02054',
          durationMinutes: 60
        }]
      }
    });
    const failed = await harness.repository.read('user-a');

    expect(saved.recalculationJob.status).toBe('failed_retryable');
    expect(failed.activeMealPlanVersionId).toBe(previous.id);
    expect(failed.trainingPlans).toHaveLength(2);
    expect(failed.dailyNutritionTargets).toHaveLength(8);

    available = true;
    const retried = await harness.service.retryPendingRecalculation('user-a', {
      expectedVersion: failed.recalculationJobs.length,
      idempotencyKey: 'retry-provider-001',
      payload: { recalculationJobId: saved.recalculationJob.id }
    });
    const after = await harness.repository.read('user-a');

    expect(retried.recalculationJob.status).toBe('completed');
    expect(after.dailyNutritionTargets).toHaveLength(failed.dailyNutritionTargets.length);
    expect(after.recalculationJobs).toHaveLength(failed.recalculationJobs.length);
    expect(after.mealPlans).toHaveLength(failed.mealPlans.length + 1);
  });

  test('atomically records a successful retry so response-loss replay cannot observe an unrecorded result', async () => {
    const inner = new InMemoryPlanningRepository();
    let dropAfterNextCommit = false;
    const repository: PlanningRepository = {
      read: (userId) => inner.read(userId),
      async transact(userId, operation) {
        const result = await inner.transact(userId, operation);
        if (dropAfterNextCommit) {
          dropAfterNextCommit = false;
          throw new Error('simulated response loss');
        }
        return result;
      }
    };
    const baseProviders = fixtureProviders();
    let available = false;
    const harness = createHarness({ repository, providers: baseProviders });
    await prepareGeneratedPlan(harness);
    harness.setProviders({
      ...baseProviders,
      menus: {
        getActiveCatalog: () => available
          ? baseProviders.menus.getActiveCatalog()
          : Promise.reject(new Error('offline')),
        getMenuByVersionId: (id) => baseProviders.menus.getMenuByVersionId(id)
      }
    });
    const saved = await harness.service.saveTrainingPlan('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'training-save-retry-response-loss',
      payload: {
        weekStartDate: WEEK_START,
        businessTimezone: 'Asia/Shanghai',
        sessions: [{
          businessDate: '2026-08-20',
          sessionCode: '02054',
          durationMinutes: 60
        }]
      }
    });
    const failed = await inner.read('user-a');
    const retryCommand = {
      expectedVersion: failed.recalculationJobs.length,
      idempotencyKey: 'retry-response-loss',
      payload: { recalculationJobId: saved.recalculationJob.id }
    } as const;

    available = true;
    dropAfterNextCommit = true;
    await expect(
      harness.service.retryPendingRecalculation('user-a', retryCommand)
    ).rejects.toThrow('simulated response loss');
    const committed = await inner.read('user-a');

    expect(committed.recalculationJobs.find(
      (job) => job.id === saved.recalculationJob.id
    )?.status).toBe('completed');
    expect(committed.idempotencyRecords.filter(
      (record) => record.operation === 'retryPendingRecalculation'
        && record.key === retryCommand.idempotencyKey
    )).toHaveLength(1);
    const planCount = committed.mealPlans.length;

    const replay = await harness.service.retryPendingRecalculation('user-a', retryCommand);
    const afterReplay = await inner.read('user-a');
    expect(replay.recalculationJob.status).toBe('completed');
    expect(afterReplay.mealPlans).toHaveLength(planCount);
    expect(afterReplay.idempotencyRecords.filter(
      (record) => record.operation === 'retryPendingRecalculation'
    )).toHaveLength(1);
    await expect(harness.service.retryPendingRecalculation('user-a', {
      ...retryCommand,
      payload: { recalculationJobId: 'different-job-id' }
    })).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
  });

  test('atomically records a retry when a background consumer activates the result after retry first-read', async () => {
    const control = createControlledRepository();
    const baseProviders = fixtureProviders();
    const harness = createHarness({
      repository: control.repository,
      providers: baseProviders
    });
    await prepareGeneratedPlan(harness);
    harness.setProviders({
      ...baseProviders,
      menus: {
        getActiveCatalog: () => Promise.reject(new Error('offline')),
        getMenuByVersionId: (id) => baseProviders.menus.getMenuByVersionId(id)
      }
    });
    const saved = await harness.service.saveTrainingPlan('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'training-save-background-activated',
      payload: {
        weekStartDate: WEEK_START,
        businessTimezone: 'Asia/Shanghai',
        sessions: [{
          businessDate: '2026-08-20',
          sessionCode: '02054',
          durationMinutes: 60
        }]
      }
    });
    const failed = await control.inner.read('user-a');
    const retryCommand = {
      expectedVersion: failed.recalculationJobs.length,
      idempotencyKey: 'retry-after-background-activated',
      payload: { recalculationJobId: saved.recalculationJob.id }
    } as const;
    harness.setProviders(baseProviders);

    control.blockNextRead();
    const retry = harness.service.retryPendingRecalculation('user-a', retryCommand);
    await control.waitForBlockedRead();
    const background = await harness.service.processTrainingPlanChanged(
      'user-a',
      saved.recalculationJob.triggerEventId
    );
    const afterBackground = await control.inner.read('user-a');
    expect(background.recalculationJob.status).toBe('completed');
    expect(background.activatedMealPlan).not.toBeNull();

    control.dropNextTransactionResponseAfterCommit();
    control.releaseBlockedRead();
    await expect(retry).rejects.toThrow('simulated response loss');
    const committed = await control.inner.read('user-a');

    expect(committed.idempotencyRecords.filter(
      (record) => record.operation === 'retryPendingRecalculation'
        && record.key === retryCommand.idempotencyKey
    )).toHaveLength(1);
    expect(committed.mealPlans).toEqual(afterBackground.mealPlans);
    expect(committed.dailyNutritionTargets).toEqual(afterBackground.dailyNutritionTargets);
    expect(committed.recalculationJobs).toEqual(afterBackground.recalculationJobs);
    expect(committed.mealPlanDecisions).toEqual(afterBackground.mealPlanDecisions);

    const replay = await harness.service.retryPendingRecalculation('user-a', retryCommand);
    const afterReplay = await control.inner.read('user-a');
    expect(replay.recalculationJob.id).toBe(saved.recalculationJob.id);
    expect(replay.activatedMealPlan?.id).toBe(background.activatedMealPlan?.id);
    expect(afterReplay.mealPlans).toEqual(committed.mealPlans);
    expect(afterReplay.idempotencyRecords.filter(
      (record) => record.operation === 'retryPendingRecalculation'
    )).toHaveLength(1);
    await expect(harness.service.retryPendingRecalculation('user-a', {
      ...retryCommand,
      payload: { recalculationJobId: 'different-job-id' }
    })).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
  });

  test('does not claim retry success when recording a background pending candidate fails and permits retry', async () => {
    const control = createControlledRepository();
    const baseProviders = fixtureProviders();
    const harness = createHarness({
      repository: control.repository,
      providers: baseProviders
    });
    await prepareGeneratedPlan(harness);
    await harness.service.setMealPlanDayLock('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'lock-before-background-candidate',
      payload: { businessDate: '2026-08-20', locked: true }
    });
    harness.setProviders({
      ...baseProviders,
      menus: {
        getActiveCatalog: () => Promise.reject(new Error('offline')),
        getMenuByVersionId: (id) => baseProviders.menus.getMenuByVersionId(id)
      }
    });
    const saved = await harness.service.saveTrainingPlan('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'training-save-background-candidate',
      payload: {
        weekStartDate: WEEK_START,
        businessTimezone: 'Asia/Shanghai',
        sessions: [{
          businessDate: '2026-08-20',
          sessionCode: '02054',
          durationMinutes: 60
        }]
      }
    });
    const failed = await control.inner.read('user-a');
    const retryCommand = {
      expectedVersion: failed.recalculationJobs.length,
      idempotencyKey: 'retry-after-background-candidate',
      payload: { recalculationJobId: saved.recalculationJob.id }
    } as const;
    harness.setProviders(baseProviders);

    control.blockNextRead();
    const retry = harness.service.retryPendingRecalculation('user-a', retryCommand);
    await control.waitForBlockedRead();
    const background = await harness.service.processTrainingPlanChanged(
      'user-a',
      saved.recalculationJob.triggerEventId
    );
    const afterBackground = await control.inner.read('user-a');
    expect(background.recalculationJob.status).toBe('pending');
    expect(background.candidateMealPlan?.readiness).toBe('pending_confirmation');

    control.failNextTransactionBeforeCommit();
    control.releaseBlockedRead();
    await expect(retry).rejects.toThrow('simulated retry record transaction failure');
    const afterFailure = await control.inner.read('user-a');

    expect(afterFailure).toEqual(afterBackground);
    expect(afterFailure.idempotencyRecords.some(
      (record) => record.operation === 'retryPendingRecalculation'
    )).toBe(false);

    const retried = await harness.service.retryPendingRecalculation('user-a', retryCommand);
    const afterRetry = await control.inner.read('user-a');
    expect(retried.candidateMealPlan?.id).toBe(background.candidateMealPlan?.id);
    expect(afterRetry.mealPlans).toEqual(afterBackground.mealPlans);
    expect(afterRetry.dailyNutritionTargets).toEqual(afterBackground.dailyNutritionTargets);
    expect(afterRetry.recalculationJobs).toEqual(afterBackground.recalculationJobs);
    expect(afterRetry.mealPlanDecisions).toEqual(afterBackground.mealPlanDecisions);
    expect(afterRetry.idempotencyRecords.filter(
      (record) => record.operation === 'retryPendingRecalculation'
    )).toHaveLength(1);
  });

  test('active inventory changing while provider records load returns version_conflict with no meal write', async () => {
    const baseProviders = fixtureProviders();
    const harness = createHarness({ providers: baseProviders });
    const previous = await prepareGeneratedPlan(harness);
    let changed = false;
    harness.setProviders({
      ...baseProviders,
      menus: {
        getActiveCatalog: async () => {
          if (!changed) {
            changed = true;
            await harness.repository.transact('user-a', (state) => {
              const active = state.inventories.at(-1);
              if (active === undefined) throw new Error('Expected inventory');
              const successor = {
                ...active,
                id: 'inventory-raced',
                version: state.inventories.length + 1,
                createdAt: '2026-08-10T00:00:01.000Z'
              };
              return {
                nextState: {
                  ...state,
                  inventories: [...state.inventories, successor],
                  activeInventoryVersionId: successor.id
                },
                result: undefined
              };
            });
          }
          return baseProviders.menus.getActiveCatalog();
        },
        getMenuByVersionId: (id) => baseProviders.menus.getMenuByVersionId(id)
      }
    });

    await expect(harness.service.saveTrainingPlan('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'training-save-race',
      payload: {
        weekStartDate: WEEK_START,
        businessTimezone: 'Asia/Shanghai',
        sessions: [{
          businessDate: '2026-08-20',
          sessionCode: '02054',
          durationMinutes: 60
        }]
      }
    })).rejects.toBeInstanceOf(VersionConflictError);
    const after = await harness.repository.read('user-a');

    expect(after.trainingPlans).toHaveLength(2);
    expect(after.recalculationJobs.at(-1)?.status).toBe('pending');
    expect(after.mealPlans).toHaveLength(1);
    expect(after.activeMealPlanVersionId).toBe(previous.id);
  });

  test('a target version changing while provider records load returns version_conflict without a candidate', async () => {
    const baseProviders = fixtureProviders();
    const harness = createHarness({ providers: baseProviders });
    const previous = await prepareGeneratedPlan(harness);
    let changed = false;
    harness.setProviders({
      ...baseProviders,
      menus: {
        getActiveCatalog: async () => {
          if (!changed) {
            changed = true;
            await harness.repository.transact('user-a', (state) => {
              const energy = state.dailyEnergyTargets.filter(
                (target) => target.businessDate === '2026-08-20'
              ).at(-1);
              const nutrition = state.dailyNutritionTargets.filter(
                (target) => target.businessDate === '2026-08-20'
              ).at(-1);
              if (energy === undefined || nutrition === undefined) {
                throw new Error('Expected target pair');
              }
              const energySuccessor = {
                ...energy,
                id: 'daily-energy-target-raced',
                version: energy.version + 1,
                createdAt: '2026-08-10T00:00:01.000Z'
              };
              const nutritionSuccessor = {
                ...nutrition,
                id: 'daily-nutrition-target-raced',
                version: nutrition.version + 1,
                createdAt: '2026-08-10T00:00:01.000Z',
                dailyEnergyTargetVersionId: energySuccessor.id
              };
              return {
                nextState: {
                  ...state,
                  dailyEnergyTargets: [...state.dailyEnergyTargets, energySuccessor],
                  dailyNutritionTargets: [...state.dailyNutritionTargets, nutritionSuccessor]
                },
                result: undefined
              };
            });
          }
          return baseProviders.menus.getActiveCatalog();
        },
        getMenuByVersionId: (id) => baseProviders.menus.getMenuByVersionId(id)
      }
    });

    await expect(harness.service.saveTrainingPlan('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'training-save-target-race',
      payload: {
        weekStartDate: WEEK_START,
        businessTimezone: 'Asia/Shanghai',
        sessions: [{
          businessDate: '2026-08-20',
          sessionCode: '02054',
          durationMinutes: 60
        }]
      }
    })).rejects.toBeInstanceOf(VersionConflictError);
    const after = await harness.repository.read('user-a');

    expect(after.trainingPlans).toHaveLength(2);
    expect(after.recalculationJobs.at(-1)?.status).toBe('pending');
    expect(after.mealPlans).toHaveLength(1);
    expect(after.activeMealPlanVersionId).toBe(previous.id);
  });

  test('provider version changing between generation load and commit check returns version_conflict without partial result writes', async () => {
    const baseProviders = fixtureProviders();
    let catalogReads = 0;
    let raceArmed = false;
    const harness = createHarness({
      providers: {
        ...baseProviders,
        menus: {
          async getActiveCatalog() {
            const catalog = await baseProviders.menus.getActiveCatalog();
            if (!raceArmed) return catalog;
            catalogReads += 1;
            return catalogReads === 2
              ? { ...catalog, datasetVersion: `${catalog.datasetVersion}-switched` }
              : catalog;
          },
          getMenuByVersionId: (id) => baseProviders.menus.getMenuByVersionId(id)
        }
      }
    });
    await prepareGeneratedPlan(harness);
    raceArmed = true;
    catalogReads = 0;
    const before = await harness.repository.read('user-a');

    await expect(harness.service.saveTrainingPlan('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'training-save-provider-switch',
      payload: {
        weekStartDate: WEEK_START,
        businessTimezone: 'Asia/Shanghai',
        sessions: [{
          businessDate: '2026-08-20',
          sessionCode: '02054',
          durationMinutes: 60
        }]
      }
    })).rejects.toBeInstanceOf(VersionConflictError);
    const after = await harness.repository.read('user-a');

    expect(catalogReads).toBe(2);
    expect(after.mealPlans).toEqual(before.mealPlans);
    expect(after.mealPlanTargetDiffs).toEqual(before.mealPlanTargetDiffs);
    expect(after.mealPlanDecisions).toEqual(before.mealPlanDecisions);
    expect(after.activeMealPlanVersionId).toBe(before.activeMealPlanVersionId);
    expect(after.recalculationJobs).toHaveLength(before.recalculationJobs.length + 1);
    expect(after.recalculationJobs.at(-1)?.status).toBe('pending');
  });

  test.each(['allergens', 'nutrients'] as const)(
    'provider %s changing without a version bump returns version_conflict without meal writes',
    async (field) => {
      const baseProviders = fixtureProviders();
      const changedSnapshots = BALANCED_SNAPSHOTS.map((snapshot, index) => index !== 0
        ? snapshot
        : field === 'allergens'
          ? { ...snapshot, allergens: [...snapshot.allergens, '甲壳类'] }
          : {
              ...snapshot,
              nutrientsPer100g: {
                ...snapshot.nutrientsPer100g,
                energyKcal: snapshot.nutrientsPer100g.energyKcal + 0.1
              }
            });
      const changedNutrition = new ReviewedNutritionCache({
        mode: 'test',
        snapshots: changedSnapshots
      });
      let armed = false;
      let snapshotReads = 0;
      let changed = false;
      const harness = createHarness({
        providers: {
          ...baseProviders,
          nutrition: {
            resolveCanonicalName: (name) => baseProviders.nutrition.resolveCanonicalName(name),
            async getSnapshot(id) {
              const snapshot = changed
                ? await changedNutrition.getSnapshot(id)
                : await baseProviders.nutrition.getSnapshot(id);
              if (armed) {
                snapshotReads += 1;
                if (snapshotReads === BALANCED_SNAPSHOTS.length) changed = true;
              }
              return snapshot;
            }
          }
        }
      });
      await prepareGeneratedPlan(harness);
      armed = true;
      const before = await harness.repository.read('user-a');

      await expect(harness.service.saveTrainingPlan('user-a', {
        expectedVersion: 1,
        idempotencyKey: `training-save-provider-${field}-content-switch`,
        payload: {
          weekStartDate: WEEK_START,
          businessTimezone: 'Asia/Shanghai',
          sessions: [{
            businessDate: '2026-08-20',
            sessionCode: '02054',
            durationMinutes: 60
          }]
        }
      })).rejects.toBeInstanceOf(VersionConflictError);
      const after = await harness.repository.read('user-a');

      expect(after.mealPlans).toEqual(before.mealPlans);
      expect(after.mealPlanTargetDiffs).toEqual(before.mealPlanTargetDiffs);
      expect(after.mealPlanDecisions).toEqual(before.mealPlanDecisions);
      expect(after.activeMealPlanVersionId).toBe(before.activeMealPlanVersionId);
      expect(after.recalculationJobs).toHaveLength(before.recalculationJobs.length + 1);
      expect(after.recalculationJobs.at(-1)?.status).toBe('pending');
    }
  );
});

describe('training completion facts', () => {
  const plannedSession = {
    businessDate: '2026-08-19',
    sessionCode: '02054',
    durationMinutes: 60
  } as const;

  test.each([
    ['duration', [{
      businessDate: '2026-08-19',
      sessionCode: '02054',
      durationMinutes: 60
    }, {
      businessDate: '2026-08-20',
      sessionCode: '02054',
      durationMinutes: 30
    }]],
    ['zero duration', [{
      businessDate: '2026-08-19',
      sessionCode: '02054',
      durationMinutes: 0
    }, {
      businessDate: '2026-08-20',
      sessionCode: '02054',
      durationMinutes: 30
    }]],
    ['move', [{
      businessDate: '2026-08-20',
      sessionCode: '02054',
      durationMinutes: 30
    }, {
      businessDate: '2026-08-21',
      sessionCode: '02054',
      durationMinutes: 30
    }]],
    ['cancellation', [{
      businessDate: '2026-08-20',
      sessionCode: '02054',
      durationMinutes: 30
    }]]
  ] as const)(
    'rejects a same-day %s change after completion without changing any aggregate record',
    async (scenario, sessions) => {
      const harness = createHarness();
      await prepareGeneratedPlan(harness, [{
        businessDate: '2026-08-19',
        sessionCode: '02054',
        durationMinutes: 30
      }, {
        businessDate: '2026-08-20',
        sessionCode: '02054',
        durationMinutes: 30
      }]);
      harness.setNow(NOW_ON_WEDNESDAY);
      await harness.service.recordTrainingCompletion('user-a', {
        expectedVersion: 0,
        idempotencyKey: `completion-before-${scenario}`,
        payload: { businessDate: '2026-08-19', completedDurationMinutes: 30 }
      });
      const before = await harness.repository.read('user-a');
      let thrown: unknown;

      try {
        await harness.service.saveTrainingPlan('user-a', {
          expectedVersion: 1,
          idempotencyKey: `training-change-after-${scenario}`,
          payload: {
            weekStartDate: WEEK_START,
            businessTimezone: 'Asia/Shanghai',
            sessions
          }
        });
      } catch (error: unknown) {
        thrown = error;
      }
      const after = await harness.repository.read('user-a');

      expect(thrown).toBeInstanceOf(PastFactImmutableError);
      expect(thrown).toMatchObject({ businessDate: '2026-08-19' });
      expect(after).toEqual(before);
      expect(after.dailyEnergyTargets.filter(
        (target) => target.trainingCompletionEventId !== undefined
      )).toEqual(before.dailyEnergyTargets.filter(
        (target) => target.trainingCompletionEventId !== undefined
      ));
      expect(after.dailyNutritionTargets.filter(
        (target) => target.trainingCompletionEventId !== undefined
      )).toEqual(before.dailyNutritionTargets.filter(
        (target) => target.trainingCompletionEventId !== undefined
      ));
    }
  );

  test('allows a different future training date to change after today completion', async () => {
    const harness = createHarness();
    await prepareGeneratedPlan(harness, [{
      businessDate: '2026-08-19',
      sessionCode: '02054',
      durationMinutes: 30
    }, {
      businessDate: '2026-08-20',
      sessionCode: '02054',
      durationMinutes: 30
    }]);
    harness.setNow(NOW_ON_WEDNESDAY);
    await harness.service.recordTrainingCompletion('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'completion-before-future-change',
      payload: { businessDate: '2026-08-19', completedDurationMinutes: 30 }
    });
    const before = await harness.repository.read('user-a');

    const saved = await harness.service.saveTrainingPlan('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'training-future-change-after-completion',
      payload: {
        weekStartDate: WEEK_START,
        businessTimezone: 'Asia/Shanghai',
        sessions: [{
          businessDate: '2026-08-19',
          sessionCode: '02054',
          durationMinutes: 30
        }, {
          businessDate: '2026-08-20',
          sessionCode: '02054',
          durationMinutes: 60
        }]
      }
    });
    const after = await harness.repository.read('user-a');

    expect(saved.recalculationJob.affectedDates).toEqual(['2026-08-20']);
    expect(after.trainingCompletionEvents).toEqual(before.trainingCompletionEvents);
    expect(after.dailyEnergyTargets.filter(
      (target) => target.trainingCompletionEventId !== undefined
    )).toEqual(before.dailyEnergyTargets.filter(
      (target) => target.trainingCompletionEventId !== undefined
    ));
  });

  test('records lower and zero completed minutes with exact event-linked targets', async () => {
    const harness = createHarness();
    await prepareGeneratedPlan(harness, [plannedSession]);
    harness.setNow(NOW_ON_WEDNESDAY);

    const recorded = await harness.service.recordTrainingCompletion('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'completion-001',
      payload: { businessDate: '2026-08-19', completedDurationMinutes: 30 }
    });

    expect(recorded.event.completedDurationMinutes).toBe(30);
    expect(recorded.dailyEnergyTargets).toHaveLength(1);
    expect(recorded.dailyNutritionTargets).toHaveLength(1);
    expect(recorded.dailyEnergyTargets[0]?.trainingCompletionEventId).toBe(recorded.event.id);
    expect(recorded.dailyNutritionTargets[0]?.trainingCompletionEventId).toBe(recorded.event.id);
    expect(recorded.dailyNutritionTargets[0]?.dailyEnergyTargetVersionId).toBe(
      recorded.dailyEnergyTargets[0]?.id
    );
    expect(recorded.dailyEnergyTargets[0]?.trainingPlanVersionId).toBe(
      recorded.event.trainingPlanVersionId
    );
    expect(recorded.dailyEnergyTargets[0]?.businessDate).toBe(recorded.event.businessDate);

    const zeroHarness = createHarness();
    await prepareGeneratedPlan(zeroHarness, [plannedSession]);
    zeroHarness.setNow(NOW_ON_WEDNESDAY);
    const zero = await zeroHarness.service.recordTrainingCompletion('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'completion-zero',
      payload: { businessDate: '2026-08-19', completedDurationMinutes: 0 }
    });
    expect(zero.event.completedDurationMinutes).toBe(0);
    expect(zero.dailyEnergyTargets).toHaveLength(1);
    expect(zero.dailyEnergyTargets[0]?.energy.kind).toBe('supported');
    expect(zero.dailyEnergyTargets[0]?.energy).toMatchObject({ trainingNetKcal: 0 });
  });

  test('rejects a future completion and an unplanned date without appending facts', async () => {
    const harness = createHarness();
    await prepareGeneratedPlan(harness, [plannedSession]);
    harness.setNow('2026-08-18T04:00:00.000Z');

    await expect(harness.service.recordTrainingCompletion('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'completion-future',
      payload: { businessDate: '2026-08-19', completedDurationMinutes: 30 }
    })).rejects.toBeInstanceOf(FutureCompletionForbiddenError);
    await expect(harness.service.recordTrainingCompletion('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'completion-unplanned',
      payload: { businessDate: '2026-08-18', completedDurationMinutes: 30 }
    })).rejects.toMatchObject({ code: 'invalid_training_plan' });
    expect((await harness.repository.read('user-a')).trainingCompletionEvents).toHaveLength(0);
  });

  test('records a past fact only and never rewrites the active meal plan', async () => {
    const harness = createHarness();
    const previous = await prepareGeneratedPlan(harness, [{
      ...plannedSession,
      businessDate: '2026-08-18'
    }]);
    const before = await harness.repository.read('user-a');
    harness.setNow(NOW_ON_WEDNESDAY);

    const recorded = await harness.service.recordTrainingCompletion('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'completion-past',
      payload: { businessDate: '2026-08-18', completedDurationMinutes: 20 }
    });
    const after = await harness.repository.read('user-a');

    expect(recorded.dailyEnergyTargets).toHaveLength(0);
    expect(recorded.dailyNutritionTargets).toHaveLength(0);
    expect(recorded.recalculationJob).toBeNull();
    expect(after.mealPlans).toEqual(before.mealPlans);
    expect(after.activeMealPlanVersionId).toBe(previous.id);
  });

  test('persists the fact and retryable job when immediate generation fails', async () => {
    const baseProviders = fixtureProviders();
    const harness = createHarness({ providers: baseProviders });
    const previous = await prepareGeneratedPlan(harness, [plannedSession]);
    harness.setNow(NOW_ON_WEDNESDAY);
    harness.setProviders({
      ...baseProviders,
      menus: {
        getActiveCatalog: () => Promise.reject(new Error('offline')),
        getMenuByVersionId: (id) => baseProviders.menus.getMenuByVersionId(id)
      }
    });

    const recorded = await harness.service.recordTrainingCompletion('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'completion-provider-fail',
      payload: { businessDate: '2026-08-19', completedDurationMinutes: 30 }
    });
    const state = await harness.repository.read('user-a');

    expect(recorded.event.id).toBe(state.trainingCompletionEvents[0]?.id);
    expect(recorded.recalculationStatus).toBe('failed_retryable');
    expect(recorded.recalculationJob?.status).toBe('failed_retryable');
    expect(state.activeMealPlanVersionId).toBe(previous.id);
    expect(state.mealPlans).toHaveLength(1);
  });

  test('creates a protected completion candidate, exact diff, and idempotently replays the fact', async () => {
    const harness = createHarness();
    await prepareGeneratedPlan(harness, [plannedSession]);
    const locked = await harness.service.setMealPlanDayLock('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'meal-lock-completion',
      payload: { businessDate: '2026-08-19', locked: true }
    });
    harness.setNow(NOW_ON_WEDNESDAY);
    const command = {
      expectedVersion: 0,
      idempotencyKey: 'completion-locked',
      payload: { businessDate: '2026-08-19', completedDurationMinutes: 30 }
    } as const;

    const recorded = await harness.service.recordTrainingCompletion('user-a', command);
    const replay = await harness.service.recordTrainingCompletion('user-a', command);
    const state = await harness.repository.read('user-a');

    expect(recorded.candidateMealPlan?.readiness).toBe('pending_confirmation');
    expect(recorded.targetDiffs).toHaveLength(1);
    expect(recorded.targetDiffs[0]?.candidateMealPlanVersionId).toBe(
      recorded.candidateMealPlan?.id
    );
    expect(replay.event.id).toBe(recorded.event.id);
    expect(state.trainingCompletionEvents).toHaveLength(1);
    expect(state.recalculationJobs).toHaveLength(1);
    expect(state.activeMealPlanVersionId).toBe(locked.id);
  });
});
