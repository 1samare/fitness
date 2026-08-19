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

  it('forwards every weekly meal action type while accepting strict runtime error responses', async () => {
    const calls: PlanningApiRequest[] = [];
    const client = createPlanningApiClient((request) => {
      calls.push(request);
      return Promise.resolve({
        success: false,
        error: { code: 'internal_error', message: 'controlled test response' }
      });
    });
    const requests: PlanningApiRequest[] = [
      { action: 'resolveFoodName', payload: { name: '测试米饭' } },
      {
        action: 'saveInventory',
        payload: {
          expectedVersion: 0,
          idempotencyKey: 'inventory-client-001',
          payload: { items: [{ name: '测试米饭', availableGrams: 5000 }] }
        }
      },
      {
        action: 'generateWeeklyMealPlan',
        payload: {
          expectedVersion: 0,
          idempotencyKey: 'generate-client-001',
          payload: { weekStartDate: '2026-08-17' }
        }
      },
      {
        action: 'setMealPlanDayLock',
        payload: {
          expectedVersion: 1,
          idempotencyKey: 'lock-client-001',
          payload: { businessDate: '2026-08-18', locked: true }
        }
      },
      {
        action: 'updateMealPlanDay',
        payload: {
          expectedVersion: 2,
          idempotencyKey: 'edit-client-001',
          payload: {
            businessDate: '2026-08-19',
            slot: 'dinner',
            recipeTemplateVersionId: 'recipe-from-server'
          }
        }
      },
      {
        action: 'recordTrainingCompletion',
        payload: {
          expectedVersion: 0,
          idempotencyKey: 'completion-client-001',
          payload: { businessDate: '2026-08-19', completedDurationMinutes: 30 }
        }
      },
      {
        action: 'decideMealPlanCandidate',
        payload: {
          expectedVersion: 0,
          idempotencyKey: 'candidate-client-001',
          payload: {
            candidateMealPlanVersionId: 'candidate-from-context',
            decision: 'keep_existing'
          }
        }
      },
      {
        action: 'retryPendingRecalculation',
        payload: {
          expectedVersion: 1,
          idempotencyKey: 'retry-client-001',
          payload: { recalculationJobId: 'job-from-response' }
        }
      },
      { action: 'getCurrentContext' }
    ];

    for (const request of requests) {
      await expect(client.call(request)).resolves.toEqual({
        success: false,
        error: { code: 'internal_error', message: 'controlled test response' }
      });
    }

    expect(calls).toEqual(requests);
  });

  it('accepts strict public food-resolution and meal-context success responses', async () => {
    const responses: unknown[] = [
      {
        success: true,
        data: {
          kind: 'food_name_resolved',
          resolution: {
            foodId: 'fixture-rice',
            canonicalNameZh: '测试米饭',
            nutritionSnapshotId: 'snapshot-fixture-rice-v1'
          }
        }
      },
      {
        success: true,
        data: {
          kind: 'current_context',
          bodyProfile: null,
          goal: null,
          trainingPlan: null,
          dailyEnergyTargets: [],
          dailyNutritionTargets: [],
          inventory: null,
          mealPlan: null,
          mealPlanStale: false,
          pendingMealPlanCandidate: null,
          pendingMealPlanTargetDiffs: [],
          selectableRecipes: [],
          selectableRecipesStatus: 'no_options',
          retryableRecalculationJob: null,
          ingredientPhoto: null,
          latestVersions: {
            bodyProfile: 0,
            goal: 0,
            trainingPlan: 0,
            inventory: 0,
            mealPlan: 0,
            mealPlanDecision: 0,
            trainingCompletion: 0,
            recalculationJob: 0,
            ingredientPhoto: 0
          }
        }
      }
    ];
    const client = createPlanningApiClient(() => Promise.resolve(responses.shift()));

    await expect(client.call({
      action: 'resolveFoodName',
      payload: { name: '测试米饭' }
    })).resolves.toMatchObject({
      success: true,
      data: { kind: 'food_name_resolved', resolution: { canonicalNameZh: '测试米饭' } }
    });
    await expect(client.call({ action: 'getCurrentContext' })).resolves.toMatchObject({
      success: true,
      data: { kind: 'current_context', mealPlan: null, mealPlanStale: false }
    });
  });
});
