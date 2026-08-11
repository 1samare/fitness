import { describe, expect, it } from 'vitest';
import {
  createMealPlanEditingService,
  createMealPlanRecalculationService,
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
  return createPlanningApiHandler(createMealPlanEditingService({
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

function createCompletionHarness() {
  const repository = new InMemoryPlanningRepository();
  let sequence = 0;
  let instant = '2026-08-10T00:00:00.000Z';
  let providerAvailable = true;
  const snapshots = balancedNutritionSnapshots.map((snapshot) => ({
    ...snapshot,
    nutrientsPer100g: { ...snapshot.nutrientsPer100g, proteinG: 6.7 }
  }));
  const nutrition = new ReviewedNutritionCache({ mode: 'test', snapshots });
  const recipes = new StaticRecipeTemplateProvider({
    mode: 'test',
    templates: TEST_RECIPE_TEMPLATES
  });
  const menus = new StaticDailyMenuCatalogProvider({
    mode: 'test',
    catalog: TEST_DAILY_MENU_CATALOG,
    menus: TEST_DAILY_MENU_TEMPLATES
  });
  const handler = createPlanningApiHandler(createMealPlanRecalculationService({
    repository,
    now: () => instant,
    nextId: (prefix) => `${prefix}-${String(++sequence)}`,
    providers: {
      nutrition,
      recipes,
      menus: {
        getActiveCatalog: () => providerAvailable
          ? menus.getActiveCatalog()
          : Promise.reject(new Error('offline')),
        getMenuByVersionId: (id) => menus.getMenuByVersionId(id)
      },
      allowTestFixtures: true
    }
  }));
  return {
    handler,
    setNow(value: string) {
      instant = value;
    },
    setProviderAvailable(value: boolean) {
      providerAvailable = value;
    }
  };
}

async function prepareCompletionPlan(harness: ReturnType<typeof createCompletionHarness>) {
  await harness.handler({
    ...completeSetup,
    payload: {
      ...completeSetup.payload,
      bodyProfile: {
        ...completeSetup.payload.bodyProfile,
        weightKg: 60,
        allergens: [],
        avoidFoods: []
      },
      goal: {
        goal: 'muscle_gain',
        effectiveDate: '2026-08-10',
        targetDate: '2026-10-30'
      },
      trainingPlan: {
        weekStartDate: '2026-08-17',
        businessTimezone: 'Asia/Shanghai',
        sessions: [{
          businessDate: '2026-08-19',
          sessionCode: '02054',
          durationMinutes: 60
        }]
      }
    }
  }, { userId: 'trusted-user-a' });
  await harness.handler({
    action: 'saveInventory',
    payload: {
      expectedVersion: 0,
      idempotencyKey: 'inventory-completion-api-001',
      payload: {
        items: TEST_NUTRITION_SNAPSHOTS.map((snapshot) => ({
          name: snapshot.canonicalNameZh,
          availableGrams: 50_000
        }))
      }
    }
  }, { userId: 'trusted-user-a' });
  await harness.handler({
    action: 'generateWeeklyMealPlan',
    payload: {
      expectedVersion: 0,
      idempotencyKey: 'meal-completion-api-001',
      payload: { weekStartDate: '2026-08-17' }
    }
  }, { userId: 'trusted-user-a' });
}

async function prepareApiMealPlan(handler: ReturnType<typeof createMealHarness>) {
  await handler({
    ...completeSetup,
    payload: {
      ...completeSetup.payload,
      bodyProfile: {
        ...completeSetup.payload.bodyProfile,
        weightKg: 60,
        allergens: [],
        avoidFoods: []
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
  await handler({
    action: 'saveInventory',
    payload: {
      expectedVersion: 0,
      idempotencyKey: 'inventory-api-edit-001',
      payload: {
        items: TEST_NUTRITION_SNAPSHOTS.map((snapshot) => ({
          name: snapshot.canonicalNameZh,
          availableGrams: 50_000
        }))
      }
    }
  }, { userId: 'trusted-user-a' });
  await handler({
    action: 'generateWeeklyMealPlan',
    payload: {
      expectedVersion: 0,
      idempotencyKey: 'meal-api-edit-generate-001',
      payload: { weekStartDate: '2026-08-17' }
    }
  }, { userId: 'trusted-user-a' });
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
        trainingCompletion: 0,
        recalculationJob: 0
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
        selectableRecipes: [],
        selectableRecipesStatus: 'no_options',
        retryableRecalculationJob: null,
        latestVersions: {
          bodyProfile: 0,
          goal: 0,
          trainingPlan: 0,
          inventory: 0,
          mealPlan: 0,
          mealPlanDecision: 0,
          trainingCompletion: 0,
          recalculationJob: 0
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

  it('locks and edits only with trusted identity and returns public selectable recipes', async () => {
    const handler = createMealHarness();
    await prepareApiMealPlan(handler);

    const context = await handler(
      { action: 'getCurrentContext' },
      { userId: 'trusted-user-a' }
    );
    expect(context.success).toBe(true);
    if (!context.success || context.data.kind !== 'current_context') {
      throw new Error('Expected current context');
    }
    expect(context.data.selectableRecipes).toContainEqual({
      recipeTemplateVersionId: 'recipe-version-fixture-day-2-dinner-v1',
      dishNameZh: '测试第2日dinner'
    });

    const locked = await handler({
      action: 'setMealPlanDayLock',
      payload: {
        expectedVersion: 1,
        idempotencyKey: 'meal-api-lock-001',
        payload: { businessDate: '2026-08-18', locked: true }
      }
    }, { userId: 'trusted-user-a' });
    expect(locked).toMatchObject({
      success: true,
      data: {
        kind: 'meal_plan_updated',
        version: { version: 2 }
      }
    });

    const edited = await handler({
      action: 'updateMealPlanDay',
      payload: {
        expectedVersion: 2,
        idempotencyKey: 'meal-api-edit-001',
        payload: {
          businessDate: '2026-08-19',
          slot: 'dinner',
          recipeTemplateVersionId: 'recipe-version-fixture-day-2-dinner-v1'
        }
      }
    }, { userId: 'trusted-user-a' });
    expect(edited).toMatchObject({
      success: true,
      data: { kind: 'meal_plan_updated', version: { version: 3 } }
    });
    if (!edited.success || edited.data.kind !== 'meal_plan_updated') {
      throw new Error('Expected updated meal plan');
    }
    expect(edited.data.version.days.find((day) => (
      day.businessDate === '2026-08-19'
    ))).toMatchObject({ locked: true, manuallyModified: true });
    expect(JSON.stringify({ context, locked, edited })).not.toContain('userId');
    expect(JSON.stringify({ context, locked, edited })).not.toContain('trusted-user-a');
  });

  it('maps past meal facts and unlisted recipes to stable public errors', async () => {
    const handler = createMealHarness();
    await prepareApiMealPlan(handler);

    await expect(handler({
      action: 'setMealPlanDayLock',
      payload: {
        expectedVersion: 1,
        idempotencyKey: 'meal-api-past-001',
        payload: { businessDate: '2026-08-10', locked: true }
      }
    }, { userId: 'trusted-user-a' })).resolves.toEqual({
      success: false,
      error: {
        code: 'past_fact_immutable',
        message: '今天及过去日期的餐单事实不可修改。'
      }
    });

    await expect(handler({
      action: 'updateMealPlanDay',
      payload: {
        expectedVersion: 1,
        idempotencyKey: 'meal-api-unlisted-001',
        payload: {
          businessDate: '2026-08-19',
          slot: 'dinner',
          recipeTemplateVersionId: 'client-invented-recipe'
        }
      }
    }, { userId: 'trusted-user-a' })).resolves.toEqual({
      success: false,
      error: {
        code: 'recipe_not_selectable',
        message: '请选择当前上下文提供的备选菜品。'
      }
    });
  });

  it('returns completion facts independently with exact public target references', async () => {
    const harness = createCompletionHarness();
    await prepareCompletionPlan(harness);
    harness.setNow('2026-08-19T04:00:00.000Z');

    const result = await harness.handler({
      action: 'recordTrainingCompletion',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'completion-api-001',
        payload: { businessDate: '2026-08-19', completedDurationMinutes: 30 }
      }
    }, { userId: 'trusted-user-a' });

    expect(result.success).toBe(true);
    if (!result.success || result.data.kind !== 'training_completion_recorded') {
      throw new Error('Expected completion response');
    }
    expect(result.data.dailyEnergyTargets).toHaveLength(1);
    expect(result.data.dailyNutritionTargets).toHaveLength(1);
    expect(result.data.dailyEnergyTargets[0]?.trainingCompletionEventId).toBe(
      result.data.event.id
    );
    expect(result.data.dailyNutritionTargets[0]?.trainingCompletionEventId).toBe(
      result.data.event.id
    );
    expect(JSON.stringify(result)).not.toContain('userId');
    expect(JSON.stringify(result)).not.toContain('trusted-user-a');
  });

  it('keeps completion success visible when immediate meal recalculation is retryable', async () => {
    const harness = createCompletionHarness();
    await prepareCompletionPlan(harness);
    harness.setNow('2026-08-19T04:00:00.000Z');
    harness.setProviderAvailable(false);

    const result = await harness.handler({
      action: 'recordTrainingCompletion',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'completion-api-offline',
        payload: { businessDate: '2026-08-19', completedDurationMinutes: 30 }
      }
    }, { userId: 'trusted-user-a' });

    expect(result).toMatchObject({
      success: true,
      data: {
        kind: 'training_completion_recorded',
        recalculationStatus: 'failed_retryable',
        recalculationJob: { status: 'failed_retryable', failureCode: 'provider_unavailable' }
      }
    });
    if (!result.success || result.data.kind !== 'training_completion_recorded') {
      throw new Error('Expected completion response');
    }
    const jobId = result.data.recalculationJob?.id;
    if (jobId === undefined) throw new Error('Expected retryable job');
    const retry = await harness.handler({
      action: 'retryPendingRecalculation',
      payload: {
        expectedVersion: 1,
        idempotencyKey: 'retry-api-offline',
        payload: { recalculationJobId: jobId }
      }
    }, { userId: 'trusted-user-a' });
    expect(retry.success).toBe(false);
    if (!retry.success) expect(retry.error.code).toBe('provider_unavailable');
  });

  it('publishes the exact recalculation-job version and retries a failed job when meal-plan count differs', async () => {
    const harness = createCompletionHarness();
    await prepareCompletionPlan(harness);
    await harness.handler({
      action: 'setMealPlanDayLock',
      payload: {
        expectedVersion: 1,
        idempotencyKey: 'retry-version-lock-001',
        payload: { businessDate: '2026-08-20', locked: true }
      }
    }, { userId: 'trusted-user-a' });
    await harness.handler({
      action: 'setMealPlanDayLock',
      payload: {
        expectedVersion: 2,
        idempotencyKey: 'retry-version-unlock-001',
        payload: { businessDate: '2026-08-20', locked: false }
      }
    }, { userId: 'trusted-user-a' });
    harness.setNow('2026-08-19T04:00:00.000Z');
    harness.setProviderAvailable(false);

    const recorded = await harness.handler({
      action: 'recordTrainingCompletion',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'completion-retry-version-001',
        payload: { businessDate: '2026-08-19', completedDurationMinutes: 30 }
      }
    }, { userId: 'trusted-user-a' });
    expect(recorded).toMatchObject({
      success: true,
      data: { kind: 'training_completion_recorded', recalculationStatus: 'failed_retryable' }
    });
    if (!recorded.success || recorded.data.kind !== 'training_completion_recorded') {
      throw new Error('Expected retryable completion');
    }

    const context = await harness.handler(
      { action: 'getCurrentContext' },
      { userId: 'trusted-user-a' }
    );
    expect(context.success).toBe(true);
    if (!context.success || context.data.kind !== 'current_context') {
      throw new Error('Expected current context');
    }
    expect(context.data.latestVersions.mealPlan).toBe(3);
    expect(context.data.latestVersions.recalculationJob).not.toBe(3);
    expect(context.data.retryableRecalculationJob).toMatchObject({
      id: recorded.data.recalculationJob?.id,
      status: 'failed_retryable'
    });

    harness.setProviderAvailable(true);
    const retried = await harness.handler({
      action: 'retryPendingRecalculation',
      payload: {
        expectedVersion: context.data.latestVersions.recalculationJob,
        idempotencyKey: 'retry-version-success-001',
        payload: { recalculationJobId: recorded.data.recalculationJob?.id ?? '' }
      }
    }, { userId: 'trusted-user-a' });

    expect(retried).toMatchObject({
      success: true,
      data: {
        kind: 'meal_plan_recalculation_processed',
        recalculationJob: { status: 'completed' }
      }
    });
  });

  it('maps future completion and a non-pending candidate to stable public errors', async () => {
    const harness = createCompletionHarness();
    await prepareCompletionPlan(harness);
    harness.setNow('2026-08-18T04:00:00.000Z');

    const future = await harness.handler({
      action: 'recordTrainingCompletion',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'completion-api-future',
        payload: { businessDate: '2026-08-19', completedDurationMinutes: 30 }
      }
    }, { userId: 'trusted-user-a' });
    expect(future.success).toBe(false);
    if (!future.success) expect(future.error.code).toBe('past_fact_immutable');

    const candidate = await harness.handler({
      action: 'decideMealPlanCandidate',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'candidate-api-missing',
        payload: {
          candidateMealPlanVersionId: 'missing-candidate',
          decision: 'keep_existing'
        }
      }
    }, { userId: 'trusted-user-a' });
    expect(candidate.success).toBe(false);
    if (!candidate.success) expect(candidate.error.code).toBe('candidate_not_pending');
  });
});
