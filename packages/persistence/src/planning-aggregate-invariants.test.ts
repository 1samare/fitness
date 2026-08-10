import { describe, expect, test } from 'vitest';
import { createVersionedPlanningService } from '@fitness/application';
import type { PlanningAggregateState } from '@fitness/domain';
import { InMemoryPlanningRepository } from './in-memory-planning-repository';
import {
  CorruptPlanningStateError,
  assertPlanningAggregateInvariants
} from './planning-aggregate-invariants';

async function createValidState(includeProfileV2 = false): Promise<PlanningAggregateState> {
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
  return repository.read('user-a');
}

async function createValidMealState(includeProfileV2 = false) {
  const state = await createValidState(includeProfileV2);
  const targets = [...state.dailyNutritionTargets].sort((left, right) => (
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
  const profile = state.bodyProfiles[0];
  const goal = state.goals[0];
  const trainingPlan = state.trainingPlans[0];
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

async function createPendingCandidateState() {
  const state = await createValidMealState();
  const activePlan = state.mealPlans[0];
  const firstDay = activePlan?.days[0];
  if (activePlan === undefined || firstDay === undefined) {
    throw new Error('Expected active meal plan fixture');
  }
  const candidate = {
    ...activePlan,
    id: 'meal-plan-2',
    version: 2,
    supersedesVersionId: activePlan.id,
    readiness: 'pending_confirmation' as const,
    days: activePlan.days.map((day, index) => (
      index === 0 ? { ...day, locked: true } : day
    ))
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
    mealPlans: [activePlan, candidate],
    mealPlanTargetDiffs: [diff]
  };
}

function expectCorrupt(state: PlanningAggregateState): void {
  expect(() => {
    assertPlanningAggregateInvariants(state, 'user-a');
  })
    .toThrow(CorruptPlanningStateError);
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

  test.each([
    'inventory',
    'mealPlan',
    'mealPlanTargetDiff',
    'mealPlanDecision',
    'trainingCompletionEvent',
    'recalculationJob'
  ] as const)('rejects a phase-4 %s record owned by another trusted user', async (recordType) => {
    const candidateState = await createPendingCandidateState();
    const candidate = candidateState.mealPlans[1];
    const activePlan = candidateState.mealPlans[0];
    const trainingPlan = candidateState.trainingPlans[0];
    const outboxEvent = candidateState.outboxEvents[0];
    if (
      candidate === undefined
      || activePlan === undefined
      || trainingPlan === undefined
      || outboxEvent === undefined
    ) {
      throw new Error('Expected phase-4 ownership fixture');
    }
    const decision = {
      kind: 'meal_plan_decision' as const,
      id: 'meal-decision-1',
      userId: 'user-a',
      version: 1,
      candidateMealPlanVersionId: candidate.id,
      previousActiveMealPlanVersionId: activePlan.id,
      decision: 'keep_existing' as const,
      decidedAt: '2026-08-10T01:00:00.000Z',
      activatedMealPlanVersionId: null
    };
    const completion = {
      kind: 'training_completion_event' as const,
      id: 'training-completion-1',
      userId: 'user-a',
      version: 1,
      trainingPlanVersionId: trainingPlan.id,
      businessDate: '2026-08-11',
      completedDurationMinutes: 30,
      occurredAt: '2026-08-11T01:00:00.000Z'
    };
    const job = {
      kind: 'recalculation_job' as const,
      id: 'recalculation-job-1',
      userId: 'user-a',
      triggerEventId: outboxEvent.eventId,
      triggerType: 'training_plan_changed' as const,
      affectedDates: outboxEvent.affectedDates,
      status: 'pending' as const,
      createdAt: '2026-08-10T01:00:00.000Z',
      completedAt: null,
      candidateMealPlanVersionId: candidate.id,
      activatedMealPlanVersionId: null,
      failureCode: null
    };
    expectCorrupt({
      ...candidateState,
      inventories: candidateState.inventories.map((value) => (
        recordType === 'inventory' ? { ...value, userId: 'user-b' } : value
      )),
      mealPlans: candidateState.mealPlans.map((value) => (
        recordType === 'mealPlan' ? { ...value, userId: 'user-b' } : value
      )),
      mealPlanTargetDiffs: candidateState.mealPlanTargetDiffs.map((value) => (
        recordType === 'mealPlanTargetDiff' ? { ...value, userId: 'user-b' } : value
      )),
      mealPlanDecisions: [{
        ...decision,
        userId: recordType === 'mealPlanDecision' ? 'user-b' : 'user-a'
      }],
      trainingCompletionEvents: [{
        ...completion,
        userId: recordType === 'trainingCompletionEvent' ? 'user-b' : 'user-a'
      }],
      recalculationJobs: [{
        ...job,
        userId: recordType === 'recalculationJob' ? 'user-b' : 'user-a'
      }]
    });
  });

  test.each(['inventory', 'mealPlan', 'mealPlanDecision', 'trainingCompletion'] as const)(
    'rejects a noncontiguous %s version sequence',
    async (recordType) => {
      const state = await createPendingCandidateState();
      const activePlan = state.mealPlans[0];
      const candidate = state.mealPlans[1];
      const trainingPlan = state.trainingPlans[0];
      if (activePlan === undefined || candidate === undefined || trainingPlan === undefined) {
        throw new Error('Expected version fixture');
      }
      const decision = {
        kind: 'meal_plan_decision' as const,
        id: 'meal-decision-gap',
        userId: 'user-a',
        version: 2,
        candidateMealPlanVersionId: candidate.id,
        previousActiveMealPlanVersionId: activePlan.id,
        decision: 'keep_existing' as const,
        decidedAt: '2026-08-10T01:00:00.000Z',
        activatedMealPlanVersionId: null
      };
      const completion = {
        kind: 'training_completion_event' as const,
        id: 'training-completion-gap',
        userId: 'user-a',
        version: 2,
        trainingPlanVersionId: trainingPlan.id,
        businessDate: '2026-08-11',
        completedDurationMinutes: 30,
        occurredAt: '2026-08-11T01:00:00.000Z'
      };
      expectCorrupt({
        ...state,
        inventories: state.inventories.map((value) => (
          recordType === 'inventory' ? { ...value, version: 2 } : value
        )),
        mealPlans: state.mealPlans.map((value) => (
          recordType === 'mealPlan' && value.version === 2 ? { ...value, version: 3 } : value
        )),
        mealPlanDecisions: recordType === 'mealPlanDecision' ? [decision] : [],
        trainingCompletionEvents: recordType === 'trainingCompletion' ? [completion] : []
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

  test('accepts a pending candidate with an exact protected-day target diff', async () => {
    const state = await createPendingCandidateState();
    expect(() => {
      assertPlanningAggregateInvariants(state, 'user-a');
    }).not.toThrow();
  });

  test('rejects a target diff that does not link to its candidate day and targets', async () => {
    const state = await createPendingCandidateState();
    const diff = state.mealPlanTargetDiffs[0];
    if (diff === undefined) throw new Error('Expected target diff fixture');
    expectCorrupt({
      ...state,
      mealPlanTargetDiffs: [{ ...diff, proposedNutritionTargetVersionId: 'missing-target' }]
    });
  });

  test('rejects decisions that reference a complete plan instead of a pending candidate', async () => {
    const state = await createValidMealState();
    const activePlan = state.mealPlans[0];
    if (activePlan === undefined) throw new Error('Expected active meal plan fixture');
    expectCorrupt({
      ...state,
      mealPlanDecisions: [{
        kind: 'meal_plan_decision',
        id: 'meal-decision-1',
        userId: 'user-a',
        version: 1,
        candidateMealPlanVersionId: activePlan.id,
        previousActiveMealPlanVersionId: activePlan.id,
        decision: 'keep_existing',
        decidedAt: '2026-08-10T01:00:00.000Z',
        activatedMealPlanVersionId: null
      }]
    });
  });

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
      failureCode: null
    };
    expectCorrupt({
      ...state,
      recalculationJobs: [
        firstJob,
        { ...firstJob, id: 'recalculation-job-2' }
      ]
    });
  });

  test('rejects a pending-confirmation meal plan as the active plan', async () => {
    const state = await createPendingCandidateState();
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
