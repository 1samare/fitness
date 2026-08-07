import { describe, expect, test } from 'vitest';
import {
  IdempotencyKeyReuseError,
  InvalidGoalError,
  PastTrainingChangeError,
  PlanningPrerequisiteError,
  VersionConflictError,
  createVersionedPlanningService
} from '@fitness/application';
import type { CompletePlanningSetupCommand } from '@fitness/domain';
import { InMemoryPlanningRepository } from './in-memory-planning-repository';

const profilePayload = {
  ageYears: 30,
  sexCode: 0 as const,
  heightCm: 175,
  weightKg: 70,
  healthScopeConfirmed: true,
  nonTrainingActivity: 'light' as const,
  allergens: ['peanut'],
  avoidFoods: ['coriander'],
  dietPreferences: ['home_cooking'],
  businessTimezone: 'Asia/Shanghai'
};

function createHarness(now = '2026-08-03T08:00:00.000Z') {
  const repository = new InMemoryPlanningRepository();
  let nextId = 0;
  const service = createVersionedPlanningService({
    repository,
    now: () => now,
    nextId: (prefix) => `${prefix}-${String(++nextId)}`
  });
  return { repository, service };
}

function planningSetup(
  overrides: Partial<CompletePlanningSetupCommand> = {}
): CompletePlanningSetupCommand {
  return {
    expectedVersions: { bodyProfile: 0, goal: 0, trainingPlan: 0 },
    idempotencyKey: 'planning-setup',
    bodyProfile: profilePayload,
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
    },
    ...overrides
  };
}

describe('versioned planning service', () => {
  test('keeps immutable profile versions and replays the same idempotent write', async () => {
    const { repository, service } = createHarness();

    const first = await service.saveBodyProfile('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'profile-create',
      payload: profilePayload
    });
    const replay = await service.saveBodyProfile('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'profile-create',
      payload: profilePayload
    });
    const second = await service.saveBodyProfile('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'profile-update',
      payload: { ...profilePayload, weightKg: 69.5 }
    });

    expect(replay).toEqual(first);
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    const state = await repository.read('user-a');
    expect(state.bodyProfiles.map((profile) => profile.payload.weightKg)).toEqual([70, 69.5]);
    expect(state.activeBodyProfileVersionId).toBe(second.id);
  });

  test('rejects stale versions and reuse of an idempotency key with another payload', async () => {
    const { service } = createHarness();
    await service.saveBodyProfile('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'profile-create',
      payload: profilePayload
    });

    await expect(service.saveBodyProfile('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'stale-update',
      payload: { ...profilePayload, weightKg: 68 }
    })).rejects.toBeInstanceOf(VersionConflictError);

    await expect(service.saveBodyProfile('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'profile-create',
      payload: { ...profilePayload, weightKg: 68 }
    })).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
  });

  test('replays a semantically identical goal when object keys use another insertion order', async () => {
    const { repository, service } = createHarness();
    await service.saveBodyProfile('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'profile-create',
      payload: profilePayload
    });

    const first = await service.saveGoal('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'goal-create',
      payload: {
        goal: 'maintain',
        effectiveDate: '2026-08-03',
        targetDate: '2026-10-26'
      }
    });
    const replay = await service.saveGoal('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'goal-create',
      payload: {
        targetDate: '2026-10-26',
        effectiveDate: '2026-08-03',
        goal: 'maintain'
      }
    });

    expect(replay).toEqual(first);
    expect((await repository.read('user-a')).goals).toHaveLength(1);
  });

  test('creates a traceable seven-day target set from the active profile, goal, and plan', async () => {
    const { repository, service } = createHarness();
    const profile = await service.saveBodyProfile('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'profile-create',
      payload: profilePayload
    });
    const goal = await service.saveGoal('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'goal-create',
      payload: {
        goal: 'maintain',
        effectiveDate: '2026-08-03',
        targetDate: '2026-10-26'
      }
    });
    const result = await service.saveTrainingPlan('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'training-create',
      payload: {
        weekStartDate: '2026-08-03',
        businessTimezone: 'Asia/Shanghai',
        sessions: [
          { businessDate: '2026-08-04', sessionCode: '02054', durationMinutes: 60 }
        ]
      }
    });

    expect(result.trainingPlan.version).toBe(1);
    expect(result.dailyEnergyTargets).toHaveLength(7);
    expect(result.dailyEnergyTargets[1]?.energy.kind).toBe('supported');
    if (result.dailyEnergyTargets[1]?.energy.kind === 'supported') {
      expect(result.dailyEnergyTargets[1].energy.trainingNetKcal).toBe(184);
    }
    for (const target of result.dailyEnergyTargets) {
      expect(target.bodyProfileVersionId).toBe(profile.id);
      expect(target.goalVersionId).toBe(goal.id);
      expect(target.trainingPlanVersionId).toBe(result.trainingPlan.id);
      expect(target.energyPolicyVersion).toBe('calculation-policy-v2');
    }

    const state = await repository.read('user-a');
    expect(state.dailyEnergyTargets).toHaveLength(7);
    expect(await service.getCurrentContext('user-b')).toEqual({
      bodyProfile: null,
      goal: null,
      trainingPlan: null,
      dailyEnergyTargets: [],
      latestVersions: { bodyProfile: 0, goal: 0, trainingPlan: 0 }
    });
  });

  test('rejects a fat-loss target below the supported BMI floor', async () => {
    const { service } = createHarness();
    await service.saveBodyProfile('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'profile-create',
      payload: profilePayload
    });

    await expect(service.saveGoal('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'goal-create',
      payload: {
        goal: 'fat_loss',
        targetWeightKg: 55,
        effectiveDate: '2026-08-03',
        targetDate: '2026-10-26'
      }
    })).rejects.toBeInstanceOf(InvalidGoalError);
  });

  test('rejects a training plan when the active goal belongs to an older profile version', async () => {
    const { service } = createHarness();
    await service.saveBodyProfile('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'profile-create',
      payload: profilePayload
    });
    await service.saveGoal('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'goal-create',
      payload: {
        goal: 'maintain',
        effectiveDate: '2026-08-03',
        targetDate: '2026-10-26'
      }
    });
    await service.saveBodyProfile('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'profile-update',
      payload: { ...profilePayload, weightKg: 69.5 }
    });

    await expect(service.saveTrainingPlan('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'training-with-stale-goal',
      payload: {
        weekStartDate: '2026-08-03',
        businessTimezone: 'Asia/Shanghai',
        sessions: []
      }
    })).rejects.toEqual(expect.objectContaining({
      name: PlanningPrerequisiteError.name,
      code: 'planning_prerequisite_missing',
      prerequisite: 'goal'
    }));
  });

  test('completes initial planning setup atomically with targets and one pending event', async () => {
    const { repository, service } = createHarness('2026-08-07T00:00:00.000Z');

    const result = await service.completePlanningSetup('user-a', planningSetup());
    const state = await repository.read('user-a');

    expect(result.bodyProfile.version).toBe(1);
    expect(result.goal.bodyProfileVersionId).toBe(result.bodyProfile.id);
    expect(result.trainingPlan.goalVersionId).toBe(result.goal.id);
    expect(result.dailyEnergyTargets).toHaveLength(7);
    expect(result.affectedDates).toEqual([
      '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13',
      '2026-08-14', '2026-08-15', '2026-08-16'
    ]);
    expect(state.bodyProfiles).toHaveLength(1);
    expect(state.goals).toHaveLength(1);
    expect(state.trainingPlans).toHaveLength(1);
    expect(state.dailyEnergyTargets).toHaveLength(7);
    expect(state.idempotencyRecords).toHaveLength(1);
    expect(state.outboxEvents).toEqual([
      expect.objectContaining({
        eventType: 'TrainingPlanChanged',
        userId: 'user-a',
        previousTrainingPlanVersionId: null,
        trainingPlanVersionId: result.trainingPlan.id,
        affectedDates: result.affectedDates,
        status: 'pending'
      })
    ]);
    for (const target of result.dailyEnergyTargets) {
      expect(target).toEqual(expect.objectContaining({
        bodyProfileVersionId: result.bodyProfile.id,
        goalVersionId: result.goal.id,
        trainingPlanVersionId: result.trainingPlan.id,
        energyPolicyVersion: 'calculation-policy-v2',
        nutritionPolicyVersion: 'nutrition-policy-v1'
      }));
    }
  });

  test('rolls back every initial setup record when goal validation fails', async () => {
    const { repository, service } = createHarness('2026-08-07T00:00:00.000Z');
    const command = planningSetup({
      goal: {
        goal: 'fat_loss',
        targetWeightKg: 55,
        effectiveDate: '2026-08-07',
        targetDate: '2026-10-30'
      }
    });

    await expect(service.completePlanningSetup('user-a', command))
      .rejects.toBeInstanceOf(InvalidGoalError);

    expect(await repository.read('user-a')).toEqual({
      bodyProfiles: [],
      goals: [],
      trainingPlans: [],
      dailyEnergyTargets: [],
      outboxEvents: [],
      idempotencyRecords: [],
      activeBodyProfileVersionId: null,
      activeGoalVersionId: null,
      activeTrainingPlanVersionId: null
    });
  });

  test('replays the complete setup with identical IDs and no duplicate records', async () => {
    const { repository, service } = createHarness('2026-08-07T00:00:00.000Z');
    const command = planningSetup();

    const first = await service.completePlanningSetup('user-a', command);
    const replay = await service.completePlanningSetup('user-a', command);
    const state = await repository.read('user-a');

    expect(replay).toEqual(first);
    expect(state.bodyProfiles).toHaveLength(1);
    expect(state.goals).toHaveLength(1);
    expect(state.trainingPlans).toHaveLength(1);
    expect(state.dailyEnergyTargets).toHaveLength(7);
    expect(state.outboxEvents).toHaveLength(1);
    expect(state.idempotencyRecords).toHaveLength(1);
  });

  test('invalidates active goal and plan after saving a new profile version', async () => {
    const { service } = createHarness('2026-08-07T00:00:00.000Z');
    await service.completePlanningSetup('user-a', planningSetup());

    const profile = await service.saveBodyProfile('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'profile-v2',
      payload: { ...profilePayload, weightKg: 69.5 }
    });

    expect(await service.getCurrentContext('user-a')).toEqual({
      bodyProfile: profile,
      goal: null,
      trainingPlan: null,
      dailyEnergyTargets: [],
      latestVersions: { bodyProfile: 2, goal: 1, trainingPlan: 1 }
    });
  });

  test('invalidates the active plan after saving a new goal for the current profile', async () => {
    const { service } = createHarness('2026-08-07T00:00:00.000Z');
    const setup = await service.completePlanningSetup('user-a', planningSetup());

    const goal = await service.saveGoal('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'goal-v2',
      payload: {
        goal: 'muscle_gain',
        effectiveDate: '2026-08-07',
        targetDate: '2026-11-30'
      }
    });

    expect(await service.getCurrentContext('user-a')).toEqual({
      bodyProfile: setup.bodyProfile,
      goal,
      trainingPlan: null,
      dailyEnergyTargets: [],
      latestVersions: { bodyProfile: 1, goal: 2, trainingPlan: 1 }
    });
  });

  test('rejects a past session change without appending any records', async () => {
    const { repository, service } = createHarness('2026-08-07T00:00:00.000Z');
    await service.completePlanningSetup('user-a', planningSetup({
      trainingPlan: {
        weekStartDate: '2026-08-03',
        businessTimezone: 'Asia/Shanghai',
        sessions: [
          { businessDate: '2026-08-08', sessionCode: '02054', durationMinutes: 60 }
        ]
      }
    }));
    const before = await repository.read('user-a');

    await expect(service.saveTrainingPlan('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'change-past-session',
      payload: {
        weekStartDate: '2026-08-03',
        businessTimezone: 'Asia/Shanghai',
        sessions: [
          { businessDate: '2026-08-06', sessionCode: '02054', durationMinutes: 30 },
          { businessDate: '2026-08-08', sessionCode: '02054', durationMinutes: 60 }
        ]
      }
    })).rejects.toBeInstanceOf(PastTrainingChangeError);

    expect(await repository.read('user-a')).toEqual(before);
  });

  test('moving a future session recalculates only old and new dates and records the exact event', async () => {
    const { repository, service } = createHarness('2026-08-07T00:00:00.000Z');
    const setup = await service.completePlanningSetup('user-a', planningSetup());

    const changed = await service.saveTrainingPlan('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'move-future-session',
      payload: {
        weekStartDate: '2026-08-10',
        businessTimezone: 'Asia/Shanghai',
        sessions: [
          { businessDate: '2026-08-13', sessionCode: '02054', durationMinutes: 60 }
        ]
      }
    });
    const state = await repository.read('user-a');

    expect(changed.dailyEnergyTargets.map((target) => target.businessDate))
      .toEqual(['2026-08-11', '2026-08-13']);
    expect(state.dailyEnergyTargets).toHaveLength(9);
    expect(state.outboxEvents.at(-1)).toEqual(expect.objectContaining({
      previousTrainingPlanVersionId: setup.trainingPlan.id,
      trainingPlanVersionId: changed.trainingPlan.id,
      affectedDates: ['2026-08-11', '2026-08-13']
    }));
    const context = await service.getCurrentContext('user-a');
    expect(context.dailyEnergyTargets).toHaveLength(7);
    expect(context.dailyEnergyTargets.find((target) => target.businessDate === '2026-08-11')
      ?.trainingPlanVersionId).toBe(changed.trainingPlan.id);
    expect(context.dailyEnergyTargets.find((target) => target.businessDate === '2026-08-12')
      ?.trainingPlanVersionId).toBe(setup.trainingPlan.id);
  });

  test('initializes a new week only inside the eligible business-date interval', async () => {
    const { service } = createHarness('2026-08-07T00:00:00.000Z');

    const result = await service.completePlanningSetup('user-a', planningSetup({
      goal: {
        goal: 'maintain',
        effectiveDate: '2026-08-12',
        targetDate: '2026-08-14'
      },
      trainingPlan: {
        weekStartDate: '2026-08-10',
        businessTimezone: 'Asia/Shanghai',
        sessions: [
          { businessDate: '2026-08-13', sessionCode: '02054', durationMinutes: 45 }
        ]
      }
    }));

    expect(result.affectedDates).toEqual(['2026-08-12', '2026-08-13', '2026-08-14']);
    expect(result.dailyEnergyTargets.map((target) => target.businessDate))
      .toEqual(['2026-08-12', '2026-08-13', '2026-08-14']);
  });
});
