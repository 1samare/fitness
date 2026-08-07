import { describe, expect, it } from 'vitest';
import type { PlanningApiRequest } from '@fitness/contracts';
import {
  createCloudPlanningTransport,
  createPlanningApiClient,
  createPlanningApiClientForMode
} from './planning-api';

describe('mini program planning API client', () => {
  it('validates the response before returning it', async () => {
    const client = createPlanningApiClient(() => Promise.resolve({
      success: true,
      data: {
        kind: 'health',
        status: 'ok',
        service: 'planning-api',
        policyVersion: 'calculation-policy-v2'
      }
    }));
    const response = await client.call({ action: 'health' });
    expect(response.success).toBe(true);
  });

  it('rejects an unvalidated server payload', async () => {
    const client = createPlanningApiClient(() => Promise.resolve({ success: true, calories: 9999 }));
    await expect(client.call({ action: 'health' })).rejects.toThrow('规划服务返回了无法识别的数据');
  });

  it('routes cloud builds through the planning-api function', async () => {
    const calls: { readonly functionName: string; readonly data: unknown }[] = [];
    const transport = createCloudPlanningTransport((functionName, data) => {
      calls.push({ functionName, data });
      return Promise.resolve({
        success: true,
        data: {
          kind: 'health',
          status: 'ok',
          service: 'planning-api',
          policyVersion: 'calculation-policy-v2'
        }
      });
    });

    await expect(transport({ action: 'health' })).resolves.toMatchObject({
      success: true,
      data: { kind: 'health' }
    });
    expect(calls).toEqual([{
      functionName: 'planning-api',
      data: { action: 'health' }
    }]);
  });

  it('forwards one complete planning setup request unchanged', async () => {
    const calls: unknown[] = [];
    const transport = createCloudPlanningTransport((_functionName, data) => {
      calls.push(data);
      return Promise.resolve({ success: true });
    });
    const request: PlanningApiRequest = {
      action: 'completePlanningSetup',
      payload: {
        expectedVersions: { bodyProfile: 0, goal: 0, trainingPlan: 0 },
        idempotencyKey: 'planning-setup-key-001',
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
          sessions: []
        }
      }
    };

    await transport(request);

    expect(calls).toEqual([request]);
  });

  it('selects the cloud transport for a cloud build', async () => {
    const calls: string[] = [];
    const response = {
      success: true,
      data: {
        kind: 'health',
        status: 'ok',
        service: 'planning-api',
        policyVersion: 'calculation-policy-v2'
      }
    } as const;
    const client = createPlanningApiClientForMode('cloud', {
      local: () => {
        calls.push('local');
        return Promise.resolve(response);
      },
      cloud: () => {
        calls.push('cloud');
        return Promise.resolve(response);
      }
    });

    await client.call({ action: 'health' });

    expect(calls).toEqual(['cloud']);
  });
});
