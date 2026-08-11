import { describe, expect, test } from 'vitest';
import { createVersionedPlanningService } from '@fitness/application';
import type { PlanningAggregateState } from '@fitness/domain';
import { InMemoryPlanningRepository } from './in-memory-planning-repository';
import {
  CorruptPlanningStateError,
  assertPlanningAggregateInvariants
} from './planning-aggregate-invariants';

async function createValidState(
  includeProfileV2 = false,
  includeTrainingV2 = false
): Promise<PlanningAggregateState> {
  const repository = new InMemoryPlanningRepository();
  let sequence = 0;
  const service = createVersionedPlanningService({
    repository,
    now: () => '2026-08-07T00:00:00.000Z',
    nextId: (prefix) => `${prefix}-${String(++sequence)}`
  });
  await service.completePlanningSetup('user-a', {
    expectedVersions: { bodyProfile: 0, goal: 0, trainingPlan: 0 },
    idempotencyKey: 'planning-setup-001',
    bodyProfile: {
      ageYears: 30,
      sexCode: 0,
      heightCm: 175,
      weightKg: 70,
      healthScopeConfirmed: true,
      nonTrainingActivity: 'light',
      allergens: [],
      avoidFoods: [],
      dietPreferences: [],
      businessTimezone: 'Asia/Shanghai'
    },
    goal: {
      goal: 'maintain',
      effectiveDate: '2026-08-07',
      targetDate: '2026-10-30'
    },
    trainingPlan: {
      weekStartDate: '2026-08-10',
      businessTimezone: 'Asia/Shanghai',
      sessions: [
        { businessDate: '2026-08-11', sessionCode: '02054', durationMinutes: 60 }
      ]
    }
  });
  if (includeProfileV2) {
    await service.saveBodyProfile('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'profile-update-001',
      payload: {
        ageYears: 30,
        sexCode: 0,
        heightCm: 175,
        weightKg: 69.5,
        healthScopeConfirmed: true,
        nonTrainingActivity: 'light',
        allergens: [],
        avoidFoods: [],
        dietPreferences: [],
        businessTimezone: 'Asia/Shanghai'
      }
    });
  }
  if (includeTrainingV2) {
    await service.saveTrainingPlan('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'training-update-001',
      payload: {
        weekStartDate: '2026-08-10',
        businessTimezone: 'Asia/Shanghai',
        sessions: [
          { businessDate: '2026-08-11', sessionCode: '02054', durationMinutes: 45 }
        ]
      }
    });
  }
  return repository.read('user-a');
}

async function createValidMealState(
  includeProfileV2 = false,
  includeTrainingV2 = false
) {
  const state = await createValidState(includeProfileV2, includeTrainingV2);
  const latestTargetsByDate = new Map<string, PlanningAggregateState['dailyNutritionTargets'][number]>();
  for (const target of state.dailyNutritionTargets) {
    const current = latestTargetsByDate.get(target.businessDate);
    if (current === undefined || target.version > current.version) {
      latestTargetsByDate.set(target.businessDate, target);
    }
  }
  const targets = [...latestTargetsByDate.values()].sort((left, right) => (
    left.businessDate.localeCompare(right.businessDate)
  ));
  if (targets.length !== 7) throw new Error('Expected seven nutrition targets');
  const inventory = {
    kind: 'inventory_version' as const,
    id: 'inventory-1',
    userId: 'user-a',
    version: 1,
    createdAt: '2026-08-10T00:00:00.000Z',
    items: [{
      foodId: 'fixture-food',
      nutritionSnapshotId: 'snapshot-fixture-food-v1',
      availableGrams: 10_000
    }]
  };
  const profile = state.bodyProfiles.find((value) => value.id === state.activeBodyProfileVersionId)
    ?? state.bodyProfiles[0];
  const goal = state.goals.find((value) => value.id === state.activeGoalVersionId)
    ?? state.goals[0];
  const trainingPlan = state.trainingPlans.find(
    (value) => value.id === state.activeTrainingPlanVersionId
  ) ?? state.trainingPlans[0];
  if (profile === undefined || goal === undefined || trainingPlan === undefined) {
    throw new Error('Expected complete planning chain');
  }
  const mealPlan = {
    kind: 'meal_plan_version' as const,
    id: 'meal-plan-1',
    userId: 'user-a',
    version: 1,
    createdAt: '2026-08-10T00:00:00.000Z',
    weekStartDate: '2026-08-10',
    bodyProfileVersionId: profile.id,
    goalVersionId: goal.id,
    trainingPlanVersionId: trainingPlan.id,
    inventoryVersionId: inventory.id,
    catalogVersionId: 'catalog-fixture-v1',
    generationPolicyVersion: 'weekly-meal-generation-v1' as const,
    supersedesVersionId: null,
    readiness: 'complete' as const,
    days: targets.map((target) => ({
      businessDate: target.businessDate,
      dailyNutritionTargetVersionId: target.id,
      dailyMenuTemplateVersionId: `menu-${target.businessDate}`,
      locked: false,
      manuallyModified: false,
      meals: [{
        slot: 'breakfast' as const,
        recipeTemplateVersionId: 'recipe-fixture-v1',
        servingMultiplier: 1
      }],
      ingredientAmounts: [{ foodId: 'fixture-food', grams: 100 }],
      nutritionTotals: {
        energyKcal: 100,
        proteinG: 10,
        fatG: 5,
        carbohydrateG: 12,
        fiberG: 3,
        saturatedFatG: 1,
        addedSugarG: 0
      },
      nutritionSourceSnapshotIds: ['snapshot-fixture-food-v1']
    }))
  };
  return {
    ...state,
    inventories: [inventory],
    mealPlans: [mealPlan],
    mealPlanTargetDiffs: [],
    mealPlanDecisions: [],
    trainingCompletionEvents: [],
    recalculationJobs: [],
    activeInventoryVersionId: inventory.id,
    activeMealPlanVersionId: mealPlan.id
  };
}

async function createOrphanPendingCandidateState(changedTargetCount = 1) {
  const state = await createValidMealState();
  const activePlan = state.mealPlans[0];
  const firstDay = activePlan?.days[0];
  if (
    activePlan === undefined
    || firstDay === undefined
    || changedTargetCount < 1
    || changedTargetCount > 7
  ) {
    throw new Error('Expected active meal plan fixture');
  }
  const nextEnergyTargets: PlanningAggregateState['dailyEnergyTargets'][number][] = [];
  const nextNutritionTargets: PlanningAggregateState['dailyNutritionTargets'][number][] = [];
  for (const day of activePlan.days.slice(0, changedTargetCount)) {
    const energyTarget = state.dailyEnergyTargets.find(
      (target) => target.businessDate === day.businessDate
    );
    const nutritionTarget = state.dailyNutritionTargets.find(
      (target) => target.id === day.dailyNutritionTargetVersionId
    );
    if (energyTarget === undefined || nutritionTarget === undefined) {
      throw new Error('Expected candidate target source fixture');
    }
    const nextEnergyTarget = {
      ...energyTarget,
      id: `daily-energy-target-next-${day.businessDate}`,
      version: energyTarget.version + 1
    };
    nextEnergyTargets.push(nextEnergyTarget);
    nextNutritionTargets.push({
      ...nutritionTarget,
      id: `daily-nutrition-target-next-${day.businessDate}`,
      version: nutritionTarget.version + 1,
      dailyEnergyTargetVersionId: nextEnergyTarget.id
    });
  }
  const nextTargetsByDate = new Map(
    nextNutritionTargets.map((target) => [target.businessDate, target])
  );
  const protectedActivePlan = {
    ...activePlan,
    days: activePlan.days.map((day, index) => (
      index < changedTargetCount ? { ...day, locked: true } : day
    ))
  };
  const candidate = {
    ...protectedActivePlan,
    id: 'meal-plan-2',
    version: 2,
    supersedesVersionId: protectedActivePlan.id,
    readiness: 'pending_confirmation' as const,
    days: protectedActivePlan.days.map((day) => {
      const nextTarget = nextTargetsByDate.get(day.businessDate);
      return nextTarget === undefined
        ? day
        : {
            ...day,
            dailyNutritionTargetVersionId: nextTarget.id,
            locked: true
          };
    })
  };
  const diff = {
    id: 'meal-diff-1',
    userId: 'user-a',
    candidateMealPlanVersionId: candidate.id,
    businessDate: firstDay.businessDate,
    previousNutritionTargetVersionId: firstDay.dailyNutritionTargetVersionId,
    proposedNutritionTargetVersionId: candidate.days[0]?.dailyNutritionTargetVersionId
      ?? firstDay.dailyNutritionTargetVersionId,
    reason: 'locked_or_manually_modified' as const
  };
  return {
    ...state,
    dailyEnergyTargets: [...state.dailyEnergyTargets, ...nextEnergyTargets],
    dailyNutritionTargets: [...state.dailyNutritionTargets, ...nextNutritionTargets],
    mealPlans: [protectedActivePlan, candidate],
    mealPlanTargetDiffs: [diff]
  };
}

async function createCandidateJobState(changedTargetCount = 1) {
  const state = await createOrphanPendingCandidateState(changedTargetCount);
  const event = state.outboxEvents[0];
  const previous = state.mealPlans[0];
  const candidate = state.mealPlans[1];
  if (event === undefined || previous === undefined || candidate === undefined) {
    throw new Error('Expected candidate job fixture');
  }
  const exactDiffs: PlanningAggregateState['mealPlanTargetDiffs'][number][] = [];
  for (const candidateDay of candidate.days) {
    const previousDay = previous.days.find(
      (day) => day.businessDate === candidateDay.businessDate
    );
    if (previousDay === undefined) throw new Error('Expected previous candidate day fixture');
    if (
      previousDay.dailyNutritionTargetVersionId
      !== candidateDay.dailyNutritionTargetVersionId
    ) {
      exactDiffs.push({
        id: `meal-diff-${(exactDiffs.length + 1).toString()}`,
        userId: 'user-a',
        candidateMealPlanVersionId: candidate.id,
        businessDate: candidateDay.businessDate,
        previousNutritionTargetVersionId: previousDay.dailyNutritionTargetVersionId,
        proposedNutritionTargetVersionId: candidateDay.dailyNutritionTargetVersionId,
        reason: 'locked_or_manually_modified'
      });
    }
  }
  const linkedEvent = {
    ...event,
    affectedDates: exactDiffs.map((diff) => diff.businessDate)
  };
  const validState: PlanningAggregateState = {
    ...state,
    outboxEvents: [linkedEvent],
    mealPlanTargetDiffs: exactDiffs,
    recalculationJobs: [{
      kind: 'recalculation_job' as const,
      id: 'recalculation-job-candidate',
      userId: 'user-a',
      triggerEventId: linkedEvent.eventId,
      triggerType: 'training_plan_changed' as const,
      affectedDates: linkedEvent.affectedDates,
      status: 'pending' as const,
      createdAt: '2026-08-10T01:00:00.000Z',
      completedAt: null,
      candidateMealPlanVersionId: candidate.id,
      activatedMealPlanVersionId: null,
      failureCode: null,
      failureConflictDetailsStatus: 'complete' as const,
      failureConflicts: []
    }]
  };
  expect(() => {
    assertPlanningAggregateInvariants(validState, 'user-a');
  }).not.toThrow();
  return validState;
}

async function createCandidateJobStateWithUnprotectedSecondDayChange() {
  const state = await createCandidateJobState(2);
  const previous = state.mealPlans[0];
  const candidate = state.mealPlans[1];
  const secondDay = previous?.days[1];
  if (
    previous === undefined
    || candidate === undefined
    || secondDay === undefined
  ) {
    throw new Error('Expected second meal plan day fixture');
  }
  const validState: PlanningAggregateState = {
    ...state,
    mealPlans: [previous, candidate].map((plan) => ({
      ...plan,
      days: plan.days.map((day) => (
        day.businessDate === secondDay.businessDate
          ? { ...day, locked: false }
          : day
      ))
    })),
    mealPlanTargetDiffs: state.mealPlanTargetDiffs.filter(
      (diff) => diff.businessDate !== secondDay.businessDate
    )
  };
  expect(() => {
    assertPlanningAggregateInvariants(validState, 'user-a');
  }).not.toThrow();
  return validState;
}

async function createCompletedCandidateJobState(
  decision: 'keep_existing' | 'overwrite_locked'
) {
  const state = await createCandidateJobState();
  const previous = state.mealPlans[0];
  const candidate = state.mealPlans[1];
  const job = state.recalculationJobs[0];
  if (previous === undefined || candidate === undefined || job === undefined) {
    throw new Error('Expected completed candidate job fixture');
  }
  const activated = decision === 'overwrite_locked'
    ? {
        ...candidate,
        id: 'meal-plan-3',
        version: 3,
        supersedesVersionId: candidate.id,
        readiness: 'complete' as const
      }
    : undefined;
  const validState: PlanningAggregateState = {
    ...state,
    mealPlans: activated === undefined
      ? state.mealPlans
      : [...state.mealPlans, activated],
    mealPlanDecisions: [{
      kind: 'meal_plan_decision' as const,
      id: 'meal-decision-1',
      userId: 'user-a',
      version: 1,
      candidateMealPlanVersionId: candidate.id,
      previousActiveMealPlanVersionId: previous.id,
      decision,
      decidedAt: '2026-08-10T02:00:00.000Z',
      activatedMealPlanVersionId: activated?.id ?? null
    }],
    recalculationJobs: [{
      ...job,
      status: 'completed' as const,
      completedAt: '2026-08-10T02:00:00.000Z',
      activatedMealPlanVersionId: activated?.id ?? null
    }]
  };
  expect(() => {
    assertPlanningAggregateInvariants(validState, 'user-a');
  }).not.toThrow();
  return validState;
}

async function createCompletedCandidateJobStateWithCompletion() {
  const state = await createCompletedCandidateJobState('keep_existing');
  const trainingPlan = state.trainingPlans[0];
  if (trainingPlan === undefined) throw new Error('Expected completion training plan fixture');
  const validState: PlanningAggregateState = {
    ...state,
    trainingCompletionEvents: [{
      kind: 'training_completion_event',
      id: 'training-completion-1',
      userId: 'user-a',
      version: 1,
      trainingPlanVersionId: trainingPlan.id,
      businessDate: '2026-08-11',
      completedDurationMinutes: 30,
      occurredAt: '2026-08-11T01:00:00.000Z'
    }]
  };
  expect(() => {
    assertPlanningAggregateInvariants(validState, 'user-a');
  }).not.toThrow();
  return validState;
}

function expectCorrupt(state: PlanningAggregateState): void {
  let thrown: unknown;
  try {
    assertPlanningAggregateInvariants(state, 'user-a');
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CorruptPlanningStateError);
  expect(thrown).toMatchObject({
    code: 'corrupt_planning_state',
    message: 'Stored planning state failed runtime validation'
  });
}

describe('planning aggregate invariants', () => {
  test('accepts an aggregate created by the real application service', async () => {
    const state = await createValidState();
    expect(() => {
      assertPlanningAggregateInvariants(state, 'user-a');
    })
      .not.toThrow();
  });

  test('accepts a complete seven-day meal aggregate with traceable inventory snapshots', async () => {
    const state = await createValidMealState();
    expect(() => {
      assertPlanningAggregateInvariants(state, 'user-a');
    }).not.toThrow();
  });

  test('accepts meal days backed by latest targets across one training supersession chain', async () => {
    const state = await createValidMealState(false, true);
    const plan = state.mealPlans[0];
    const firstTrainingPlan = state.trainingPlans[0];
    const secondTrainingPlan = state.trainingPlans[1];
    if (plan === undefined || firstTrainingPlan === undefined || secondTrainingPlan === undefined) {
      throw new Error('Expected mixed training target fixture');
    }
    const targetTrainingPlanIds = plan.days.map((day) => state.dailyNutritionTargets.find(
      (target) => target.id === day.dailyNutritionTargetVersionId
    )?.trainingPlanVersionId);
    expect(targetTrainingPlanIds.filter((id) => id === firstTrainingPlan.id)).toHaveLength(6);
    expect(targetTrainingPlanIds.filter((id) => id === secondTrainingPlan.id)).toHaveLength(1);

    expect(() => {
      assertPlanningAggregateInvariants(state, 'user-a');
    }).not.toThrow();
  });

  test('rejects a meal target from a parallel same-week training supersession branch', async () => {
    const state = await createValidMealState(false, true);
    const rootPlan = state.trainingPlans[0];
    const branchPlan = state.trainingPlans[1];
    const mealPlan = state.mealPlans[0];
    const sourceEvent = state.outboxEvents[1];
    if (
      rootPlan === undefined
      || branchPlan === undefined
      || mealPlan === undefined
      || sourceEvent === undefined
    ) {
      throw new Error('Expected parallel training branch fixture');
    }
    const currentPlan = {
      ...branchPlan,
      id: 'training-plan-parallel-current',
      version: 3
    };
    const currentEvent = {
      ...sourceEvent,
      eventId: 'training-plan-changed-parallel-current',
      previousTrainingPlanVersionId: rootPlan.id,
      trainingPlanVersionId: currentPlan.id
    };

    expectCorrupt({
      ...state,
      trainingPlans: [...state.trainingPlans, currentPlan],
      outboxEvents: [...state.outboxEvents, currentEvent],
      mealPlans: [{ ...mealPlan, trainingPlanVersionId: currentPlan.id }],
      activeTrainingPlanVersionId: currentPlan.id,
      idempotencyRecords: []
    });
  });

  test('rejects a meal target from after its top-level training plan version', async () => {
    const state = await createValidMealState(false, true);
    const topLevelPlan = state.trainingPlans[1];
    const mealPlan = state.mealPlans[0];
    const sourceEvent = state.outboxEvents[1];
    const firstDay = mealPlan?.days[0];
    const sourceTarget = state.dailyNutritionTargets.find(
      (target) => target.id === firstDay?.dailyNutritionTargetVersionId
    );
    const sourceEnergy = state.dailyEnergyTargets.find(
      (target) => target.id === sourceTarget?.dailyEnergyTargetVersionId
    );
    if (
      topLevelPlan === undefined
      || mealPlan === undefined
      || sourceEvent === undefined
      || sourceTarget === undefined
      || sourceEnergy === undefined
    ) {
      throw new Error('Expected future training target fixture');
    }
    const futurePlan = {
      ...topLevelPlan,
      id: 'training-plan-future',
      version: 3
    };
    const futureEvent = {
      ...sourceEvent,
      eventId: 'training-plan-changed-future',
      previousTrainingPlanVersionId: topLevelPlan.id,
      trainingPlanVersionId: futurePlan.id
    };

    expectCorrupt({
      ...state,
      trainingPlans: [...state.trainingPlans, futurePlan],
      outboxEvents: [...state.outboxEvents, futureEvent],
      dailyEnergyTargets: state.dailyEnergyTargets.map((target) => (
        target.id === sourceEnergy.id
          ? { ...target, trainingPlanVersionId: futurePlan.id }
          : target
      )),
      dailyNutritionTargets: state.dailyNutritionTargets.map((target) => (
        target.id === sourceTarget.id
          ? { ...target, trainingPlanVersionId: futurePlan.id }
          : target
      )),
      activeTrainingPlanVersionId: futurePlan.id,
      idempotencyRecords: []
    });
  });

  test('rejects a meal day whose target belongs to another date', async () => {
    const state = await createValidMealState();
    const mealPlan = state.mealPlans[0];
    const firstDay = mealPlan?.days[0];
    const secondDay = mealPlan?.days[1];
    if (mealPlan === undefined || firstDay === undefined || secondDay === undefined) {
      throw new Error('Expected meal target date fixture');
    }
    expectCorrupt({
      ...state,
      mealPlans: [{
        ...mealPlan,
        days: mealPlan.days.map((day) => (
          day.businessDate === firstDay.businessDate
            ? { ...day, dailyNutritionTargetVersionId: secondDay.dailyNutritionTargetVersionId }
            : day
        ))
      }]
    });
  });

  test.each([
    'inventory',
    'mealPlan',
    'mealPlanTargetDiff',
    'mealPlanDecision',
    'trainingCompletionEvent',
    'recalculationJob'
  ] as const)('rejects a phase-4 %s record owned by another trusted user', async (recordType) => {
    const candidateState = await createCompletedCandidateJobStateWithCompletion();
    const candidate = candidateState.mealPlans[1];
    if (candidate === undefined) throw new Error('Expected phase-4 ownership fixture');
    expectCorrupt({
      ...candidateState,
      inventories: candidateState.inventories.map((value) => (
        recordType === 'inventory' ? { ...value, userId: 'user-b' } : value
      )),
      mealPlans: candidateState.mealPlans.map((value) => (
        recordType === 'mealPlan' && value.id === candidate.id
          ? { ...value, userId: 'user-b' }
          : value
      )),
      mealPlanTargetDiffs: candidateState.mealPlanTargetDiffs.map((value) => (
        recordType === 'mealPlanTargetDiff' ? { ...value, userId: 'user-b' } : value
      )),
      mealPlanDecisions: candidateState.mealPlanDecisions.map((value) => (
        recordType === 'mealPlanDecision' ? { ...value, userId: 'user-b' } : value
      )),
      trainingCompletionEvents: candidateState.trainingCompletionEvents.map((value) => (
        recordType === 'trainingCompletionEvent' ? { ...value, userId: 'user-b' } : value
      )),
      recalculationJobs: candidateState.recalculationJobs.map((value) => (
        recordType === 'recalculationJob' ? { ...value, userId: 'user-b' } : value
      ))
    });
  });

  test.each(['inventory', 'mealPlan', 'mealPlanDecision', 'trainingCompletion'] as const)(
    'rejects a noncontiguous %s version sequence',
    async (recordType) => {
      const state = await createCompletedCandidateJobStateWithCompletion();
      const candidate = state.mealPlans[1];
      if (candidate === undefined) throw new Error('Expected version fixture');
      expectCorrupt({
        ...state,
        inventories: state.inventories.map((value) => (
          recordType === 'inventory' ? { ...value, version: 2 } : value
        )),
        mealPlans: state.mealPlans.map((value) => (
          recordType === 'mealPlan' && value.id === candidate.id
            ? { ...value, version: 3 }
            : value
        )),
        mealPlanDecisions: state.mealPlanDecisions.map((value) => (
          recordType === 'mealPlanDecision' ? { ...value, version: 2 } : value
        )),
        trainingCompletionEvents: state.trainingCompletionEvents.map((value) => (
          recordType === 'trainingCompletion' ? { ...value, version: 2 } : value
        ))
      });
    }
  );

  test.each(['missing_day', 'duplicate_day', 'unordered_days', 'outside_week'] as const)(
    'rejects meal plans with invalid seven-day week membership: %s',
    async (corruption) => {
      const state = await createValidMealState();
      const plan = state.mealPlans[0];
      const first = plan?.days[0];
      const second = plan?.days[1];
      if (plan === undefined || first === undefined || second === undefined) {
        throw new Error('Expected meal week fixture');
      }
      const days = corruption === 'missing_day'
        ? plan.days.slice(0, 6)
        : corruption === 'duplicate_day'
          ? [first, first, ...plan.days.slice(2)]
          : corruption === 'unordered_days'
            ? [second, first, ...plan.days.slice(2)]
            : [{ ...first, businessDate: '2026-08-17' }, ...plan.days.slice(1)];
      expectCorrupt({
        ...state,
        mealPlans: [{ ...plan, days }]
      });
    }
  );

  test.each(['inventory', 'nutritionTarget'] as const)(
    'rejects a meal plan with a dangling %s reference',
    async (reference) => {
      const state = await createValidMealState();
      const plan = state.mealPlans[0];
      if (plan === undefined) throw new Error('Expected meal plan fixture');
      expectCorrupt({
        ...state,
        mealPlans: [{
          ...plan,
          inventoryVersionId: reference === 'inventory'
            ? 'missing-inventory'
            : plan.inventoryVersionId,
          days: plan.days.map((day, index) => (
            reference === 'nutritionTarget' && index === 0
              ? { ...day, dailyNutritionTargetVersionId: 'missing-target' }
              : day
          ))
        }]
      });
    }
  );

  test('rejects a meal plan whose existing profile is outside its training chain', async () => {
    const state = await createValidMealState(true);
    const plan = state.mealPlans[0];
    const secondProfile = state.bodyProfiles[1];
    if (plan === undefined || secondProfile === undefined) {
      throw new Error('Expected cross-chain fixture');
    }
    expectCorrupt({
      ...state,
      mealPlans: [{ ...plan, bodyProfileVersionId: secondProfile.id }]
    });
  });

  test('rejects a meal plan whose existing goal is outside its training chain', async () => {
    const state = await createValidMealState();
    const plan = state.mealPlans[0];
    const goal = state.goals[0];
    if (plan === undefined || goal === undefined) {
      throw new Error('Expected cross-goal fixture');
    }
    const otherGoal = { ...goal, id: 'goal-other', version: 2 };
    expectCorrupt({
      ...state,
      goals: [...state.goals, otherGoal],
      mealPlans: [{ ...plan, goalVersionId: otherGoal.id }],
      idempotencyRecords: []
    });
  });

  test('rejects persisted ingredient snapshots that disagree with the referenced inventory', async () => {
    const state = await createValidMealState();
    const inventory = state.inventories[0];
    if (inventory === undefined) throw new Error('Expected inventory fixture');
    expectCorrupt({
      ...state,
      inventories: [{
        ...inventory,
        items: inventory.items.map((item) => ({
          ...item,
          nutritionSnapshotId: 'snapshot-different-v1'
        }))
      }]
    });
  });

  test('accepts a pending candidate with an exact protected-day target diff and job', async () => {
    const state = await createCandidateJobState();
    expect(() => {
      assertPlanningAggregateInvariants(state, 'user-a');
    }).not.toThrow();
  });

  test('rejects a pending candidate with an exact diff but no recalculation job', async () => {
    const state = await createOrphanPendingCandidateState();
    expectCorrupt(state);
  });

  test('rejects a target diff that does not link to its candidate day and targets', async () => {
    const state = await createCandidateJobState();
    const diff = state.mealPlanTargetDiffs[0];
    if (diff === undefined) throw new Error('Expected target diff fixture');
    expectCorrupt({
      ...state,
      mealPlanTargetDiffs: [{ ...diff, proposedNutritionTargetVersionId: 'missing-target' }]
    });
  });

  test('rejects a pending candidate missing one changed protected-day diff', async () => {
    const state = await createCandidateJobState(2);
    expectCorrupt({ ...state, mealPlanTargetDiffs: state.mealPlanTargetDiffs.slice(0, 1) });
  });

  test('rejects clearing a changed protected day on the candidate', async () => {
    const state = await createCandidateJobState(2);
    const previous = state.mealPlans[0];
    const candidate = state.mealPlans[1];
    const secondDay = candidate?.days[1];
    if (previous === undefined || candidate === undefined || secondDay === undefined) {
      throw new Error('Expected cleared protection fixture');
    }
    expectCorrupt({
      ...state,
      mealPlans: [
        previous,
        {
          ...candidate,
          days: candidate.days.map((day) => (
            day.businessDate === secondDay.businessDate
              ? { ...day, locked: false }
              : day
          ))
        }
      ]
    });
  });

  test.each(['locked', 'manuallyModified'] as const)(
    'rejects clearing the superseded day %s flag even when its target is unchanged',
    async (flag) => {
      const state = await createCandidateJobState();
      const previous = state.mealPlans[0];
      const candidate = state.mealPlans[1];
      const previousDay = previous?.days[1];
      if (previous === undefined || candidate === undefined || previousDay === undefined) {
        throw new Error('Expected unchanged protected-day fixture');
      }
      expectCorrupt({
        ...state,
        mealPlans: [
          {
            ...previous,
            days: previous.days.map((day) => (
              day.businessDate === previousDay.businessDate
                ? { ...day, [flag]: true }
                : day
            ))
          },
          candidate
        ]
      });
    }
  );

  test('rejects an extra diff for an unprotected changed day', async () => {
    const state = await createCandidateJobStateWithUnprotectedSecondDayChange();
    const previous = state.mealPlans[0];
    const candidate = state.mealPlans[1];
    const secondPreviousDay = previous?.days[1];
    const secondCandidateDay = candidate?.days[1];
    if (
      previous === undefined
      || candidate === undefined
      || secondPreviousDay === undefined
      || secondCandidateDay === undefined
    ) {
      throw new Error('Expected extra diff fixture');
    }
    expect(secondPreviousDay.locked || secondPreviousDay.manuallyModified).toBe(false);
    expect(secondCandidateDay.dailyNutritionTargetVersionId).not.toBe(
      secondPreviousDay.dailyNutritionTargetVersionId
    );
    expect(state.dailyNutritionTargets.some(
      (target) => target.id === secondCandidateDay.dailyNutritionTargetVersionId
    )).toBe(true);
    expectCorrupt({
      ...state,
      mealPlanTargetDiffs: [
        ...state.mealPlanTargetDiffs,
        {
          id: 'meal-diff-extra',
          userId: 'user-a',
          candidateMealPlanVersionId: candidate.id,
          businessDate: secondPreviousDay.businessDate,
          previousNutritionTargetVersionId: secondPreviousDay.dailyNutritionTargetVersionId,
          proposedNutritionTargetVersionId: secondCandidateDay.dailyNutritionTargetVersionId,
          reason: 'locked_or_manually_modified'
        }
      ]
    });
  });

  test('rejects a pending diff whose previous and proposed target IDs are equal', async () => {
    const state = await createCandidateJobState();
    const diff = state.mealPlanTargetDiffs[0];
    if (diff === undefined) throw new Error('Expected same-target diff fixture');
    expectCorrupt({
      ...state,
      mealPlanTargetDiffs: [{
        ...diff,
        proposedNutritionTargetVersionId: diff.previousNutritionTargetVersionId
      }]
    });
  });

  test('rejects decisions that reference a complete plan instead of a pending candidate', async () => {
    const state = await createCompletedCandidateJobState('keep_existing');
    const previous = state.mealPlans[0];
    const decision = state.mealPlanDecisions[0];
    if (previous === undefined || decision === undefined) {
      throw new Error('Expected complete decision fixture');
    }
    expectCorrupt({
      ...state,
      mealPlanDecisions: [{
        ...decision,
        candidateMealPlanVersionId: previous.id
      }]
    });
  });

  test.each(['keep_existing', 'overwrite_locked'] as const)(
    'accepts a completed candidate job closed by one %s decision',
    async (decision) => {
      const state = await createCompletedCandidateJobState(decision);
      expect(() => {
        assertPlanningAggregateInvariants(state, 'user-a');
      }).not.toThrow();
    }
  );

  test('rejects an orphan decision without its candidate recalculation job', async () => {
    const state = await createCompletedCandidateJobState('keep_existing');
    expectCorrupt({ ...state, recalculationJobs: [] });
  });

  test('rejects a completed candidate job without a decision', async () => {
    const state = await createCompletedCandidateJobState('keep_existing');
    expectCorrupt({ ...state, mealPlanDecisions: [] });
  });

  test.each(['pending', 'failed_retryable'] as const)(
    'rejects a %s candidate job that already has a decision',
    async (status) => {
      const state = await createCompletedCandidateJobState('keep_existing');
      const job = state.recalculationJobs[0];
      if (job === undefined) throw new Error('Expected unfinished decision fixture');
      expectCorrupt({
        ...state,
        recalculationJobs: [{
          ...job,
          status,
          completedAt: null,
          failureCode: status === 'failed_retryable' ? 'provider_unavailable' : null
        }]
      });
    }
  );

  test.each(['job_missing_activation', 'decision_keep_existing'] as const)(
    'rejects a completed candidate lifecycle with mismatched result: %s',
    async (mismatch) => {
      const state = await createCompletedCandidateJobState('overwrite_locked');
      const decision = state.mealPlanDecisions[0];
      const job = state.recalculationJobs[0];
      if (decision === undefined || job === undefined) {
        throw new Error('Expected mismatched decision fixture');
      }
      expectCorrupt({
        ...state,
        mealPlanDecisions: mismatch === 'decision_keep_existing'
          ? [{
              ...decision,
              decision: 'keep_existing',
              activatedMealPlanVersionId: null
            }]
          : state.mealPlanDecisions,
        recalculationJobs: mismatch === 'job_missing_activation'
          ? [{ ...job, activatedMealPlanVersionId: null }]
          : state.recalculationJobs
      });
    }
  );

  test('rejects two recalculation jobs that share one candidate', async () => {
    const state = await createCandidateJobState();
    const event = state.outboxEvents[0];
    const job = state.recalculationJobs[0];
    if (event === undefined || job === undefined) {
      throw new Error('Expected duplicate candidate job fixture');
    }
    expectCorrupt({
      ...state,
      outboxEvents: [
        event,
        { ...event, eventId: 'training-plan-changed-second' }
      ],
      recalculationJobs: [
        job,
        {
          ...job,
          id: 'recalculation-job-candidate-second',
          triggerEventId: 'training-plan-changed-second'
        }
      ]
    });
  });

  test('rejects two decisions that share one candidate', async () => {
    const state = await createCompletedCandidateJobState('keep_existing');
    const decision = state.mealPlanDecisions[0];
    if (decision === undefined) throw new Error('Expected duplicate candidate decision fixture');
    expectCorrupt({
      ...state,
      mealPlanDecisions: [
        decision,
        { ...decision, id: 'meal-decision-2', version: 2 }
      ]
    });
  });

  test.each(['candidate', 'previous', 'unrelated_complete'] as const)(
    'rejects overwrite_locked activation of the %s plan',
    async (activatedPlanKind) => {
      const state = await createCompletedCandidateJobState('overwrite_locked');
      const previous = state.mealPlans[0];
      const candidate = state.mealPlans[1];
      const activated = state.mealPlans[2];
      const decision = state.mealPlanDecisions[0];
      const job = state.recalculationJobs[0];
      if (
        previous === undefined
        || candidate === undefined
        || activated === undefined
        || decision === undefined
        || job === undefined
      ) {
        throw new Error('Expected invalid overwrite fixture');
      }
      const activatedMealPlanVersionId = activatedPlanKind === 'candidate'
        ? candidate.id
        : activatedPlanKind === 'previous'
          ? previous.id
          : activated.id;
      expectCorrupt({
        ...state,
        mealPlans: activatedPlanKind === 'unrelated_complete'
          ? state.mealPlans.map((plan) => (
              plan.id === activated.id
                ? { ...plan, supersedesVersionId: previous.id }
                : plan
            ))
          : state.mealPlans,
        mealPlanDecisions: activatedPlanKind === 'unrelated_complete'
          ? state.mealPlanDecisions
          : [{ ...decision, activatedMealPlanVersionId }],
        recalculationJobs: activatedPlanKind === 'unrelated_complete'
          ? state.recalculationJobs
          : [{ ...job, activatedMealPlanVersionId }]
      });
    }
  );

  test('rejects duplicate recalculation jobs for the same trigger event', async () => {
    const state = await createValidMealState();
    const event = state.outboxEvents[0];
    if (event === undefined) throw new Error('Expected outbox event fixture');
    const firstJob = {
      kind: 'recalculation_job' as const,
      id: 'recalculation-job-1',
      userId: 'user-a',
      triggerEventId: event.eventId,
      triggerType: 'training_plan_changed' as const,
      affectedDates: event.affectedDates,
      status: 'pending' as const,
      createdAt: '2026-08-10T01:00:00.000Z',
      completedAt: null,
      candidateMealPlanVersionId: null,
      activatedMealPlanVersionId: null,
      failureCode: null,
      failureConflictDetailsStatus: 'complete' as const,
      failureConflicts: []
    };
    expectCorrupt({
      ...state,
      recalculationJobs: [
        firstJob,
        { ...firstJob, id: 'recalculation-job-2' }
      ]
    });
  });

  test('accepts only explicit legacy-unavailable provenance for a nutrition failure without details', async () => {
    const state = await createValidMealState();
    const event = state.outboxEvents[0];
    if (event === undefined) throw new Error('Expected failure trigger fixture');
    const failedJob = {
      kind: 'recalculation_job' as const,
      id: 'recalculation-job-legacy-failure',
      userId: 'user-a',
      triggerEventId: event.eventId,
      triggerType: 'training_plan_changed' as const,
      affectedDates: event.affectedDates,
      status: 'failed_retryable' as const,
      createdAt: '2026-08-10T01:00:00.000Z',
      completedAt: null,
      candidateMealPlanVersionId: null,
      activatedMealPlanVersionId: null,
      failureCode: 'nutrition_constraints_infeasible' as const,
      failureConflicts: []
    };

    expect(() => {
      assertPlanningAggregateInvariants({
        ...state,
        recalculationJobs: [{
          ...failedJob,
          failureConflictDetailsStatus: 'legacy_unavailable'
        }]
      }, 'user-a');
    }).not.toThrow();
    expectCorrupt({
      ...state,
      recalculationJobs: [{
        ...failedJob,
        failureConflictDetailsStatus: 'complete'
      }]
    });
  });

  test('accepts a sanitized complete nutrition failure snapshot and rejects internal identifiers', async () => {
    const state = await createValidMealState();
    const event = state.outboxEvents[0];
    if (event === undefined) throw new Error('Expected failure trigger fixture');
    const failedJob = {
      kind: 'recalculation_job' as const,
      id: 'recalculation-job-complete-failure',
      userId: 'user-a',
      triggerEventId: event.eventId,
      triggerType: 'training_plan_changed' as const,
      affectedDates: event.affectedDates,
      status: 'failed_retryable' as const,
      createdAt: '2026-08-10T01:00:00.000Z',
      completedAt: null,
      candidateMealPlanVersionId: null,
      activatedMealPlanVersionId: null,
      failureCode: 'nutrition_constraints_infeasible' as const,
      failureConflictDetailsStatus: 'complete' as const,
      failureConflicts: [{
        code: 'inventory_insufficient' as const,
        businessDate: event.affectedDates[0] ?? '2026-08-10',
        foodNameZh: '审核鸡蛋',
        requiredGrams: 120,
        availableGrams: 20
      }]
    };

    expect(() => {
      assertPlanningAggregateInvariants({ ...state, recalculationJobs: [failedJob] }, 'user-a');
    }).not.toThrow();
    const conflictWithInternalId = {
      ...failedJob.failureConflicts[0],
      foodId: 'internal-food-id'
    } as unknown as typeof failedJob.failureConflicts[number];
    expectCorrupt({
      ...state,
      recalculationJobs: [{
        ...failedJob,
        failureConflicts: [conflictWithInternalId]
      }]
    });
  });

  test('accepts a candidate job bound to its trigger plan and changed target dates', async () => {
    const state = await createCandidateJobState();
    expect(() => {
      assertPlanningAggregateInvariants(state, 'user-a');
    }).not.toThrow();
  });

  test('rejects a candidate job whose trigger belongs to another training plan chain', async () => {
    const state = await createCandidateJobState();
    const event = state.outboxEvents[0];
    const originalTrainingPlan = state.trainingPlans[0];
    if (event === undefined || originalTrainingPlan === undefined) {
      throw new Error('Expected cross-plan job fixture');
    }
    const otherTrainingPlan = {
      ...originalTrainingPlan,
      id: 'training-plan-other',
      version: 2
    };
    expectCorrupt({
      ...state,
      trainingPlans: [...state.trainingPlans, otherTrainingPlan],
      outboxEvents: [{
        ...event,
        previousTrainingPlanVersionId: originalTrainingPlan.id,
        trainingPlanVersionId: otherTrainingPlan.id
      }],
      idempotencyRecords: []
    });
  });

  test('rejects job affected dates that do not match the result target changes', async () => {
    const state = await createCandidateJobState();
    const event = state.outboxEvents[0];
    const job = state.recalculationJobs[0];
    const unrelatedDay = state.mealPlans[0]?.days[1];
    if (event === undefined || job === undefined || unrelatedDay === undefined) {
      throw new Error('Expected affected-date job fixture');
    }
    expectCorrupt({
      ...state,
      outboxEvents: [{ ...event, affectedDates: [unrelatedDay.businessDate] }],
      recalculationJobs: [{ ...job, affectedDates: [unrelatedDay.businessDate] }]
    });
  });

  test('rejects a pending-confirmation meal plan as the active plan', async () => {
    const state = await createCandidateJobState();
    const candidate = state.mealPlans[1];
    if (candidate === undefined) throw new Error('Expected pending candidate fixture');
    expectCorrupt({
      ...state,
      activeMealPlanVersionId: candidate.id
    });
  });

  test('rejects a gap in global body profile versions', async () => {
    const state = await createValidState(true);
    const first = state.bodyProfiles[0];
    const second = state.bodyProfiles[1];
    if (first === undefined || second === undefined) throw new Error('Expected profile v2 fixture');
    expectCorrupt({
      ...state,
      bodyProfiles: [first, { ...second, version: 3 }]
    });
  });

  test('rejects duplicate entity IDs', async () => {
    const state = await createValidState(true);
    const first = state.bodyProfiles[0];
    const second = state.bodyProfiles[1];
    if (first === undefined || second === undefined) throw new Error('Expected profiles');
    expectCorrupt({
      ...state,
      bodyProfiles: [first, { ...second, id: first.id }],
      activeBodyProfileVersionId: first.id
    });
  });

  test('rejects an active pointer to a missing entity', async () => {
    expectCorrupt({
      ...await createValidState(),
      activeTrainingPlanVersionId: 'missing-plan'
    });
  });

  test('rejects a goal referencing a missing profile', async () => {
    const state = await createValidState();
    expectCorrupt({
      ...state,
      goals: state.goals.map((goal) => ({
        ...goal,
        bodyProfileVersionId: 'missing-profile'
      }))
    });
  });

  test('rejects a daily target version gap for one business date', async () => {
    const state = await createValidState();
    const target = state.dailyEnergyTargets[0];
    if (target === undefined) throw new Error('Expected a daily target');
    expectCorrupt({
      ...state,
      dailyEnergyTargets: [
        ...state.dailyEnergyTargets,
        { ...target, id: 'daily-target-gap', version: 3 }
      ]
    });
  });

  test('rejects a nutrition target with a missing or mismatched energy source', async () => {
    const state = await createValidState();
    const target = state.dailyNutritionTargets[0];
    if (target === undefined) throw new Error('Expected a daily nutrition target');
    expectCorrupt({
      ...state,
      dailyNutritionTargets: [{ ...target, dailyEnergyTargetVersionId: 'missing-energy' }]
    });
    const energyTarget = state.dailyEnergyTargets[0];
    if (energyTarget === undefined) throw new Error('Expected a daily energy target');
    expectCorrupt({
      ...state,
      dailyNutritionTargets: [{
        ...target,
        businessDate: '2026-08-12',
        dailyEnergyTargetVersionId: energyTarget.id
      }]
    });
  });

  test.each(['eventId', 'dailyEnergyTargetVersionIds'] as const)(
    'rejects a composite idempotency result with a missing %s reference',
    async (field) => {
      const state = await createValidState();
      expectCorrupt({
        ...state,
        idempotencyRecords: state.idempotencyRecords.map((record) => {
          if (record.operation !== 'completePlanningSetup') return record;
          return {
            ...record,
            resultVersionIds: {
              ...record.resultVersionIds,
              ...(field === 'eventId'
                ? { eventId: 'missing-event' }
                : { dailyEnergyTargetVersionIds: ['missing-target'] })
            }
          };
        })
      });
    }
  );

  test('rejects an outbox event referencing a missing training plan', async () => {
    const state = await createValidState();
    expectCorrupt({
      ...state,
      outboxEvents: state.outboxEvents.map((event) => ({
        ...event,
        trainingPlanVersionId: 'missing-plan'
      }))
    });
  });

  test.each(['bodyProfile', 'goal', 'trainingPlan', 'dailyTarget', 'nutritionTarget', 'event'] as const)(
    'rejects a %s record owned by another trusted user',
    async (recordType) => {
      const state = await createValidState();
      expectCorrupt({
        ...state,
        bodyProfiles: state.bodyProfiles.map((value) => (
          recordType === 'bodyProfile' ? { ...value, userId: 'user-b' } : value
        )),
        goals: state.goals.map((value) => (
          recordType === 'goal' ? { ...value, userId: 'user-b' } : value
        )),
        trainingPlans: state.trainingPlans.map((value) => (
          recordType === 'trainingPlan' ? { ...value, userId: 'user-b' } : value
        )),
        dailyEnergyTargets: state.dailyEnergyTargets.map((value) => (
          recordType === 'dailyTarget' ? { ...value, userId: 'user-b' } : value
        )),
        dailyNutritionTargets: state.dailyNutritionTargets.map((value) => (
          recordType === 'nutritionTarget' ? { ...value, userId: 'user-b' } : value
        )),
        outboxEvents: state.outboxEvents.map((value) => (
          recordType === 'event' ? { ...value, userId: 'user-b' } : value
        ))
      });
    }
  );
});
