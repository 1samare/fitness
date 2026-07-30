import { describe, expect, it } from 'vitest';
import { handlePlanningApi } from './handler';

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
});
