import { describe, expect, it } from 'vitest';
import {
  createMealPlanGenerationService,
  createVersionedPlanningService
} from '@fitness/application';
import {
  TEST_DAILY_MENU_CATALOG,
  TEST_DAILY_MENU_TEMPLATES,
  TEST_NUTRITION_SNAPSHOTS,
  TEST_RECIPE_TEMPLATES
} from '@fitness/nutrition-fixtures';
import { InMemoryPlanningRepository } from '@fitness/persistence';
import {
  ReviewedNutritionCache,
  StaticDailyMenuCatalogProvider,
  StaticRecipeTemplateProvider
} from '@fitness/providers';
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

const balancedNutritionSnapshots = TEST_NUTRITION_SNAPSHOTS.map((snapshot) => ({
  ...snapshot,
  nutrientsPer100g: {
    energyKcal: 160,
    proteinG: 5,
    fatG: 4.5,
    carbohydrateG: 24,
    fiberG: 2.2,
    saturatedFatG: 0.4,
    addedSugarG: 0
  }
}));

function createHarness() {
  let sequence = 0;
  return createPlanningApiHandler(createVersionedPlanningService({
    repository: new InMemoryPlanningRepository(),
    now: () => '2026-08-07T00:00:00.000Z',
    nextId: (prefix) => `${prefix}-${String(++sequence)}`
  }));
}

function createMealHarness() {
  let sequence = 0;
  return createPlanningApiHandler(createMealPlanGenerationService({
    repository: new InMemoryPlanningRepository(),
    now: () => '2026-08-10T00:00:00.000Z',
    nextId: (prefix) => `${prefix}-${String(++sequence)}`,
    providers: {
      nutrition: new ReviewedNutritionCache({
        mode: 'test',
        snapshots: balancedNutritionSnapshots
      }),
      recipes: new StaticRecipeTemplateProvider({
        mode: 'test',
        templates: TEST_RECIPE_TEMPLATES
      }),
      menus: new StaticDailyMenuCatalogProvider({
        mode: 'test',
        catalog: TEST_DAILY_MENU_CATALOG,
        menus: TEST_DAILY_MENU_TEMPLATES
      }),
      allowTestFixtures: true
    }
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
        expect(first.data.dailyNutritionTargets).toHaveLength(7);
        expect(first.data.dailyEnergyTargets[0]).toEqual(expect.objectContaining({
          energyPolicyVersion: 'calculation-policy-v2',
          nutritionPolicyVersion: 'nutrition-policy-v1'
        }));
        expect(first.data.dailyNutritionTargets[0]).toEqual(expect.objectContaining({
          dailyEnergyTargetVersionId: first.data.dailyEnergyTargets[0]?.id,
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
        trainingPlan: 1,
        inventory: 0,
        mealPlan: 0,
        mealPlanDecision: 0,
        trainingCompletion: 0
      });
      expect(current.data.dailyNutritionTargets).toHaveLength(7);
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
        dailyNutritionTargets: [],
        inventory: null,
        mealPlan: null,
        mealPlanStale: false,
        pendingMealPlanCandidate: null,
        pendingMealPlanTargetDiffs: [],
        latestVersions: {
          bodyProfile: 0,
          goal: 0,
          trainingPlan: 0,
          inventory: 0,
          mealPlan: 0,
          mealPlanDecision: 0,
          trainingCompletion: 0
        }
      }
    });
  });

  it('saves inventory and generates a public weekly meal plan using only trusted identity', async () => {
    const handler = createMealHarness();
    const setup = await handler({
      ...completeSetup,
      payload: {
        ...completeSetup.payload,
        bodyProfile: {
          ...completeSetup.payload.bodyProfile,
          weightKg: 60
        },
        goal: {
          ...completeSetup.payload.goal,
          goal: 'fat_loss',
          effectiveDate: '2026-08-10'
        },
        trainingPlan: {
          weekStartDate: '2026-08-17',
          businessTimezone: 'Asia/Shanghai',
          sessions: []
        }
      }
    }, { userId: 'trusted-user-a' });
    expect(setup.success).toBe(true);

    const resolved = await handler({
      action: 'resolveFoodName',
      payload: { name: '测试米饭' }
    }, { userId: 'trusted-user-a' });
    expect(resolved).toEqual({
      success: true,
      data: {
        kind: 'food_name_resolved',
        resolution: {
          foodId: 'fixture-rice',
          canonicalNameZh: '测试米饭',
          nutritionSnapshotId: 'snapshot-fixture-rice-v1'
        }
      }
    });

    const saved = await handler({
      action: 'saveInventory',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'inventory-api-save-001',
        payload: {
          items: TEST_NUTRITION_SNAPSHOTS.map((snapshot) => ({
            name: snapshot.canonicalNameZh,
            availableGrams: 50_000
          }))
        }
      }
    }, { userId: 'trusted-user-a' });
    expect(saved.success).toBe(true);
    expect(JSON.stringify(saved)).not.toContain('userId');

    const generated = await handler({
      action: 'generateWeeklyMealPlan',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'meal-api-generate-001',
        payload: { weekStartDate: '2026-08-17' }
      }
    }, { userId: 'trusted-user-a' });
    expect(generated.success).toBe(true);
    if (generated.success && generated.data.kind === 'weekly_meal_plan_generated') {
      expect(generated.data.version.days).toHaveLength(7);
      expect(generated.data.version.readiness).toBe('complete');
    }
    expect(JSON.stringify(generated)).not.toContain('userId');
    expect(JSON.stringify(generated)).not.toContain('trusted-user-a');
  });

  it('maps deterministic weekly infeasibility to its stable public error', async () => {
    const handler = createMealHarness();
    await handler({
      ...completeSetup,
      payload: {
        ...completeSetup.payload,
        bodyProfile: { ...completeSetup.payload.bodyProfile, weightKg: 60 },
        goal: {
          ...completeSetup.payload.goal,
          goal: 'fat_loss',
          effectiveDate: '2026-08-10'
        },
        trainingPlan: {
          weekStartDate: '2026-08-17',
          businessTimezone: 'Asia/Shanghai',
          sessions: []
        }
      }
    }, { userId: 'trusted-user-a' });
    await handler({
      action: 'saveInventory',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'inventory-api-infeasible-001',
        payload: { items: [{ name: '测试米饭', availableGrams: 100 }] }
      }
    }, { userId: 'trusted-user-a' });

    const result = await handler({
      action: 'generateWeeklyMealPlan',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'meal-api-infeasible-001',
        payload: { weekStartDate: '2026-08-17' }
      }
    }, { userId: 'trusted-user-a' });

    expect(result).toEqual({
      success: false,
      error: {
        code: 'nutrition_constraints_infeasible',
        message: '当前食材与营养目标无法生成可行的一周餐单。'
      }
    });
  });
});
