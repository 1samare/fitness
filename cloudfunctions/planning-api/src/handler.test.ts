import { describe, expect, it } from 'vitest';
import { handlePlanningApi } from './handler';

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
