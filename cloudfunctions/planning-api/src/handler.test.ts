import { describe, expect, it } from 'vitest';
import { createVersionedPlanningService } from '@fitness/application';
import { InMemoryPlanningRepository } from '@fitness/persistence';
import { createPlanningApiHandler, handlePlanningApi } from './handler';

const profileWrite = {
  action: 'saveBodyProfile',
  payload: {
    expectedVersion: 0,
    idempotencyKey: 'profile-create-001',
    payload: {
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
    }
  }
} as const;

const completeSetup = {
  action: 'completePlanningSetup',
  payload: {
    expectedVersions: { bodyProfile: 0, goal: 0, trainingPlan: 0 },
    idempotencyKey: 'planning-setup-001',
    bodyProfile: profileWrite.payload.payload,
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
  }
} as const;

function createHarness() {
  let sequence = 0;
  return createPlanningApiHandler(createVersionedPlanningService({
    repository: new InMemoryPlanningRepository(),
    now: () => '2026-08-07T00:00:00.000Z',
    nextId: (prefix) => `${prefix}-${String(++sequence)}`
  }));
}

describe('handlePlanningApi', () => {
  it('returns the health response', async () => {
    await expect(handlePlanningApi({ action: 'health' })).resolves.toEqual({
      success: true,
      data: {
        kind: 'health',
        status: 'ok',
        service: 'planning-api',
        policyVersion: 'calculation-policy-v2'
      }
    });
  });

  it('distinguishes unknown actions from invalid requests', async () => {
    const unknownAction = await handlePlanningApi({ action: 'dropDatabase' });
    expect(unknownAction.success).toBe(false);
    if (!unknownAction.success) expect(unknownAction.error.code).toBe('unknown_action');

    const invalidRequest = await handlePlanningApi({ action: 'previewDailyEnergy', payload: {} });
    expect(invalidRequest.success).toBe(false);
    if (!invalidRequest.success) expect(invalidRequest.error.code).toBe('invalid_request');
  });

  it('reports an invalid request field without echoing its value', async () => {
    const result = await handlePlanningApi({
      action: 'getCurrentContext',
      unexpectedTransportKey: 'private-value'
    }, { userId: 'trusted-user-a' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe(
        '请求参数不合法。诊断：根对象：Unrecognized key: "unexpectedTransportKey"'
      );
    }
    expect(JSON.stringify(result)).not.toContain('private-value');
  });

  it('maps an unreviewed session to a stable fail-closed error', async () => {
    const request = {
      action: 'previewDailyEnergy',
      payload: {
        ageYears: 30,
        sexCode: 0,
        heightCm: 175,
        weightKg: 70,
        healthScopeConfirmed: true,
        nonTrainingActivity: 'light',
        goal: 'maintain',
        training: { sessionCode: '99999', durationMinutes: 60 }
      }
    };
    const result = await handlePlanningApi(request);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('unknown_training_session');
  });

  it('requires a trusted runtime identity for writes', async () => {
    const result = await handlePlanningApi(profileWrite);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('unauthenticated');
  });

  it('requires trusted identity for atomic setup and rejects client-selected identity', async () => {
    const handler = createHarness();
    const unauthenticated = await handler(completeSetup);
    expect(unauthenticated).toEqual({
      success: false,
      error: { code: 'unauthenticated', message: '需要可信的微信用户身份。' }
    });

    const clientSelected = await handler(
      { ...completeSetup, userId: 'attacker' },
      { userId: 'trusted-user-a' }
    );
    expect(clientSelected.success).toBe(false);
    if (!clientSelected.success) expect(clientSelected.error.code).toBe('invalid_request');
  });

  it('returns and replays a public atomic setup without exposing user identity', async () => {
    const handler = createHarness();
    const first = await handler(completeSetup, { userId: 'trusted-user-a' });
    const replay = await handler(completeSetup, { userId: 'trusted-user-a' });

    expect(first.success).toBe(true);
    if (first.success) {
      expect(first.data).toEqual(expect.objectContaining({
        kind: 'planning_setup_completed',
        affectedDates: [
          '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13',
          '2026-08-14', '2026-08-15', '2026-08-16'
        ]
      }));
      if (first.data.kind === 'planning_setup_completed') {
        expect(first.data.dailyEnergyTargets).toHaveLength(7);
        expect(first.data.dailyEnergyTargets[0]).toEqual(expect.objectContaining({
          energyPolicyVersion: 'calculation-policy-v2',
          nutritionPolicyVersion: 'nutrition-policy-v1'
        }));
      }
    }
    expect(replay).toEqual(first);
    expect(JSON.stringify(first)).not.toContain('userId');
    expect(JSON.stringify(first)).not.toContain('trusted-user-a');

    const current = await handler(
      { action: 'getCurrentContext' },
      { userId: 'trusted-user-a' }
    );
    expect(current.success).toBe(true);
    if (current.success && current.data.kind === 'current_context') {
      expect(current.data.latestVersions).toEqual({
        bodyProfile: 1,
        goal: 1,
        trainingPlan: 1
      });
    }
  });

  it('maps past changes and dates outside the goal period to stable error codes', async () => {
    const pastHandler = createHarness();
    await pastHandler({
      ...completeSetup,
      payload: {
        ...completeSetup.payload,
        trainingPlan: {
          weekStartDate: '2026-08-03',
          businessTimezone: 'Asia/Shanghai',
          sessions: [
            { businessDate: '2026-08-08', sessionCode: '02054', durationMinutes: 60 }
          ]
        }
      }
    }, { userId: 'trusted-user-a' });
    const past = await pastHandler({
      action: 'saveTrainingPlan',
      payload: {
        expectedVersion: 1,
        idempotencyKey: 'change-past-001',
        payload: {
          weekStartDate: '2026-08-03',
          businessTimezone: 'Asia/Shanghai',
          sessions: [
            { businessDate: '2026-08-06', sessionCode: '02054', durationMinutes: 30 },
            { businessDate: '2026-08-08', sessionCode: '02054', durationMinutes: 60 }
          ]
        }
      }
    }, { userId: 'trusted-user-a' });
    expect(past.success).toBe(false);
    if (!past.success) expect(past.error.code).toBe('past_training_change_forbidden');

    const periodHandler = createHarness();
    await periodHandler({
      ...completeSetup,
      payload: {
        ...completeSetup.payload,
        goal: {
          goal: 'maintain',
          effectiveDate: '2026-08-07',
          targetDate: '2026-08-14'
        },
        trainingPlan: {
          weekStartDate: '2026-08-10',
          businessTimezone: 'Asia/Shanghai',
          sessions: [
            { businessDate: '2026-08-13', sessionCode: '02054', durationMinutes: 60 }
          ]
        }
      }
    }, { userId: 'trusted-user-a' });
    const outside = await periodHandler({
      action: 'saveTrainingPlan',
      payload: {
        expectedVersion: 1,
        idempotencyKey: 'outside-goal-001',
        payload: {
          weekStartDate: '2026-08-10',
          businessTimezone: 'Asia/Shanghai',
          sessions: [
            { businessDate: '2026-08-13', sessionCode: '02054', durationMinutes: 60 },
            { businessDate: '2026-08-15', sessionCode: '02054', durationMinutes: 30 }
          ]
        }
      }
    }, { userId: 'trusted-user-a' });
    expect(outside.success).toBe(false);
    if (!outside.success) {
      expect(outside.error.code).toBe('training_date_outside_goal_period');
    }
  });

  it('uses the trusted context identity and isolates another user', async () => {
    const saved = await handlePlanningApi(profileWrite, { userId: 'trusted-user-a' });
    expect(saved.success).toBe(true);
    if (saved.success) expect(saved.data.kind).toBe('body_profile_saved');

    const contextA = await handlePlanningApi(
      { action: 'getCurrentContext' },
      { userId: 'trusted-user-a' }
    );
    const contextB = await handlePlanningApi(
      { action: 'getCurrentContext' },
      { userId: 'trusted-user-b' }
    );
    expect(contextA.success).toBe(true);
    expect(contextB).toEqual({
      success: true,
      data: {
        kind: 'current_context',
        bodyProfile: null,
        goal: null,
        trainingPlan: null,
        dailyEnergyTargets: [],
        latestVersions: { bodyProfile: 0, goal: 0, trainingPlan: 0 }
      }
    });
  });
});
