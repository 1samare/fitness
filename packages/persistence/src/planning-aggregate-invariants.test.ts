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
