import { describe, expect, test } from 'vitest';
import {
  IdempotencyKeyReuseError,
  InvalidGoalError,
  VersionConflictError,
  createVersionedPlanningService
} from '@fitness/application';
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

function createHarness() {
  const repository = new InMemoryPlanningRepository();
  let nextId = 0;
  const service = createVersionedPlanningService({
    repository,
    now: () => '2026-08-03T08:00:00.000Z',
    nextId: (prefix) => `${prefix}-${String(++nextId)}`
  });
  return { repository, service };
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
      dailyEnergyTargets: []
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
});
