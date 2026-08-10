import { describe, expect, it } from 'vitest';
import {
  planningAggregateStateSchema,
  planningApiRequestSchema,
  planningApiResponseSchema
} from './planning-api';

const supportedRequest = {
  action: 'previewDailyEnergy',
  payload: {
    ageYears: 30,
    sexCode: 0,
    heightCm: 175,
    weightKg: 70,
    healthScopeConfirmed: true,
    nonTrainingActivity: 'light',
    goal: 'maintain',
    training: { sessionCode: '02054', durationMinutes: 60 }
  }
} as const;

const supportedResponse = {
  success: true,
  data: {
    kind: 'supported',
    bmi: 22.86,
    estimatedBmrKcal: 1582,
    nonTrainingBaselineKcal: 2373,
    trainingNetKcal: 184,
    estimatedMaintenanceKcal: 2557,
    targetEnergyKcal: 2557,
    policy: {
      policyVersion: 'calculation-policy-v2',
      sourceIds: ['CN-BMR-2023', 'CN-DRI-MACRO-2017', 'MET-COMPENDIUM-2024'],
      applicableAgeRange: { minInclusive: 18, maxInclusive: 45 },
      applicableBmiRange: { minInclusive: 18.5, maxExclusive: 24 },
      rounding: { kcal: 'nearest_whole_half_up', bmi: 'nearest_hundredth_half_up' }
    },
    disclaimer: '初始估算，仅供一般健身与膳食规划参考，不构成医疗建议。'
  }
} as const;

describe('planning API contracts', () => {
  it('accepts a complete schema-v4 planning aggregate state', () => {
    const mealDates = [
      '2026-08-17',
      '2026-08-18',
      '2026-08-19',
      '2026-08-20',
      '2026-08-21',
      '2026-08-22',
      '2026-08-23'
    ];
    const mealPlan = {
      kind: 'meal_plan_version',
      id: 'meal-plan-1',
      userId: 'user-a',
      version: 1,
      createdAt: '2026-08-10T00:00:00.000Z',
      weekStartDate: '2026-08-17',
      bodyProfileVersionId: 'body-profile-1',
      goalVersionId: 'goal-1',
      trainingPlanVersionId: 'training-plan-1',
      inventoryVersionId: 'inventory-1',
      catalogVersionId: 'catalog-1',
      generationPolicyVersion: 'weekly-meal-generation-v1',
      supersedesVersionId: null,
      readiness: 'pending_confirmation',
      days: mealDates.map((businessDate, index) => ({
        businessDate,
        dailyNutritionTargetVersionId: `nutrition-target-${String(index + 1)}`,
        dailyMenuTemplateVersionId: `daily-menu-${String(index + 1)}`,
        locked: index === 0,
        manuallyModified: false,
        meals: [{
          slot: 'breakfast',
          recipeTemplateVersionId: 'recipe-1',
          servingMultiplier: 1
        }],
        ingredientAmounts: [{ foodId: 'food-1', grams: 100 }],
        nutritionTotals: {
          energyKcal: 100,
          proteinG: 10,
          fatG: 5,
          carbohydrateG: 12,
          fiberG: 3,
          saturatedFatG: 1,
          addedSugarG: 0
        },
        nutritionSourceSnapshotIds: ['snapshot-food-1-v1']
      }))
    };
    const requestFingerprint = `v2:sha256:${'a'.repeat(64)}`;
    const v4State = {
      bodyProfiles: [],
      goals: [],
      trainingPlans: [],
      dailyEnergyTargets: [],
      dailyNutritionTargets: [],
      inventories: [{
        kind: 'inventory_version',
        id: 'inventory-1',
        userId: 'user-a',
        version: 1,
        createdAt: '2026-08-10T00:00:00.000Z',
        items: [{
          foodId: 'food-1',
          nutritionSnapshotId: 'snapshot-food-1-v1',
          availableGrams: 1_000
        }]
      }],
      mealPlans: [mealPlan],
      mealPlanTargetDiffs: [{
        id: 'meal-diff-1',
        userId: 'user-a',
        candidateMealPlanVersionId: 'meal-plan-1',
        businessDate: '2026-08-17',
        previousNutritionTargetVersionId: 'nutrition-target-old-1',
        proposedNutritionTargetVersionId: 'nutrition-target-1',
        reason: 'locked_or_manually_modified'
      }],
      mealPlanDecisions: [{
        kind: 'meal_plan_decision',
        id: 'meal-decision-1',
        userId: 'user-a',
        version: 1,
        candidateMealPlanVersionId: 'meal-plan-1',
        previousActiveMealPlanVersionId: 'meal-plan-old-1',
        decision: 'keep_existing',
        decidedAt: '2026-08-10T01:00:00.000Z',
        activatedMealPlanVersionId: null
      }],
      trainingCompletionEvents: [{
        kind: 'training_completion_event',
        id: 'training-completion-1',
        userId: 'user-a',
        version: 1,
        trainingPlanVersionId: 'training-plan-1',
        businessDate: '2026-08-17',
        completedDurationMinutes: 0,
        occurredAt: '2026-08-17T01:00:00.000Z'
      }],
      recalculationJobs: [{
        kind: 'recalculation_job',
        id: 'recalculation-job-1',
        userId: 'user-a',
        triggerEventId: 'training-completion-1',
        triggerType: 'training_completion',
        affectedDates: ['2026-08-17'],
        status: 'pending',
        createdAt: '2026-08-17T01:00:00.000Z',
        completedAt: null,
        candidateMealPlanVersionId: 'meal-plan-1',
        activatedMealPlanVersionId: null,
        failureCode: null
      }],
      outboxEvents: [],
      idempotencyRecords: [
        ['saveInventory', 'inventory-1'],
        ['generateWeeklyMealPlan', 'meal-plan-1'],
        ['setMealPlanDayLock', 'meal-plan-1'],
        ['updateMealPlanDay', 'meal-plan-1'],
        ['recordTrainingCompletion', 'training-completion-1'],
        ['decideMealPlanCandidate', 'meal-decision-1'],
        ['retryPendingRecalculation', 'recalculation-job-1']
      ].map(([operation, resultVersionId], index) => ({
        operation,
        key: `phase4-operation-${String(index + 1)}`,
        requestFingerprint,
        resultVersionId
      })),
      activeBodyProfileVersionId: null,
      activeGoalVersionId: null,
      activeTrainingPlanVersionId: null,
      activeInventoryVersionId: 'inventory-1',
      activeMealPlanVersionId: null
    };

    expect(planningAggregateStateSchema.parse(v4State)).toEqual(v4State);
  });

  it('accepts the two whitelisted actions', () => {
    expect(planningApiRequestSchema.parse({ action: 'health' })).toEqual({ action: 'health' });
    expect(planningApiRequestSchema.parse(supportedRequest)).toEqual(supportedRequest);
  });

  it('accepts strict phase-four inventory and generation actions without client identity', () => {
    const resolve = {
      action: 'resolveFoodName',
      payload: { name: '测试米饭' }
    } as const;
    const save = {
      action: 'saveInventory',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'inventory-save-001',
        payload: { items: [{ name: '测试米饭', availableGrams: 5000 }] }
      }
    } as const;
    const generate = {
      action: 'generateWeeklyMealPlan',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'meal-generate-001',
        payload: { weekStartDate: '2026-08-17' }
      }
    } as const;

    expect(planningApiRequestSchema.parse(resolve)).toEqual(resolve);
    expect(planningApiRequestSchema.parse(save)).toEqual(save);
    expect(planningApiRequestSchema.parse(generate)).toEqual(generate);
    expect(() => planningApiRequestSchema.parse({
      ...save,
      payload: { ...save.payload, userId: 'attacker' }
    })).toThrow();
    expect(() => planningApiRequestSchema.parse({
      ...generate,
      payload: {
        ...generate.payload,
        payload: { ...generate.payload.payload, nutritionTotals: { energyKcal: 1 } }
      }
    })).toThrow();
    expect(() => planningApiRequestSchema.parse({
      ...resolve,
      payload: { ...resolve.payload, foodId: 'client-selected' }
    })).toThrow();
  });

  it('accepts only strict server-selected meal lock and edit commands', () => {
    const lock = {
      action: 'setMealPlanDayLock',
      payload: {
        expectedVersion: 1,
        idempotencyKey: 'meal-lock-001',
        payload: { businessDate: '2026-08-19', locked: true }
      }
    } as const;
    const edit = {
      action: 'updateMealPlanDay',
      payload: {
        expectedVersion: 1,
        idempotencyKey: 'meal-edit-001',
        payload: {
          businessDate: '2026-08-19',
          slot: 'dinner',
          recipeTemplateVersionId: 'recipe-version-reviewed-v1'
        }
      }
    } as const;

    expect(planningApiRequestSchema.parse(lock)).toEqual(lock);
    expect(planningApiRequestSchema.parse(edit)).toEqual(edit);
    expect(() => planningApiRequestSchema.parse({
      ...lock,
      payload: { ...lock.payload, userId: 'attacker' }
    })).toThrow();
    expect(() => planningApiRequestSchema.parse({
      ...edit,
      payload: {
        ...edit.payload,
        payload: { ...edit.payload.payload, userId: 'attacker' }
      }
    })).toThrow();
    expect(() => planningApiRequestSchema.parse({
      ...edit,
      payload: {
        ...edit.payload,
        payload: { ...edit.payload.payload, slot: 'late_night' }
      }
    })).toThrow();
    expect(() => planningApiRequestSchema.parse({
      ...edit,
      payload: {
        ...edit.payload,
        payload: { ...edit.payload.payload, nutritionTotals: { energyKcal: 1 } }
      }
    })).toThrow();
  });

  it('parses public inventory responses and rejects stored user identity', () => {
    const response = {
      success: true,
      data: {
        kind: 'inventory_saved',
        version: {
          kind: 'inventory_version',
          id: 'inventory-1',
          version: 1,
          createdAt: '2026-08-10T00:00:00.000Z',
          items: [{
            foodId: 'fixture-rice',
            nutritionSnapshotId: 'snapshot-fixture-rice-v1',
            availableGrams: 5000
          }]
        }
      }
    } as const;

    expect(planningApiResponseSchema.parse(response)).toEqual(response);
    expect(() => planningApiResponseSchema.parse({
      ...response,
      data: {
        ...response.data,
        version: { ...response.data.version, userId: 'private-user' }
      }
    })).toThrow();
  });

  it('rejects malformed numbers', () => {
    expect(() => planningApiRequestSchema.parse({
      ...supportedRequest,
      payload: {
        ...supportedRequest.payload,
        weightKg: Number.NaN
      }
    })).toThrow();
  });

  it('rejects client supplied MET', () => {
    expect(() => planningApiRequestSchema.parse({
      ...supportedRequest,
      payload: {
        ...supportedRequest.payload,
        training: { sessionCode: '02054', durationMinutes: 60, met: 3.5 }
      }
    })).toThrow();

    expect(() => planningApiRequestSchema.parse({
      action: 'saveTrainingPlan',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'training-client-met-001',
        payload: {
          weekStartDate: '2026-08-10',
          businessTimezone: 'Asia/Shanghai',
          sessions: [{
            businessDate: '2026-08-10',
            sessionCode: '02050',
            durationMinutes: 60,
            met: 6
          }]
        }
      }
    })).toThrow();
  });

  it('parses a supported response envelope', () => {
    expect(planningApiResponseSchema.parse(supportedResponse)).toEqual(supportedResponse);
  });

  it('rejects negative or fractional display energy values', () => {
    expect(() => planningApiResponseSchema.parse({
      ...supportedResponse,
      data: { ...supportedResponse.data, trainingNetKcal: -1 }
    })).toThrow();
    expect(() => planningApiResponseSchema.parse({
      ...supportedResponse,
      data: { ...supportedResponse.data, targetEnergyKcal: 2557.5 }
    })).toThrow();
  });

  it('accepts versioned writes without accepting a client userId', () => {
    const request = {
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
          allergens: ['peanut'],
          avoidFoods: [],
          dietPreferences: ['home_cooking'],
          businessTimezone: 'Asia/Shanghai'
        }
      }
    } as const;

    expect(planningApiRequestSchema.parse(request)).toEqual(request);
    expect(() => planningApiRequestSchema.parse({
      ...request,
      payload: { ...request.payload, userId: 'attacker-selected-user' }
    })).toThrow();
  });

  it('requires version and idempotency controls on every write', () => {
    expect(() => planningApiRequestSchema.parse({
      action: 'saveGoal',
      payload: {
        payload: {
          goal: 'maintain',
          effectiveDate: '2026-08-03',
          targetDate: '2026-10-26'
        }
      }
    })).toThrow();
  });

  it('rejects impossible goal and training calendar dates', () => {
    expect(() => planningApiRequestSchema.parse({
      action: 'saveGoal',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'goal-invalid-date-001',
        payload: {
          goal: 'maintain',
          effectiveDate: '2026-02-30',
          targetDate: '2026-03-30'
        }
      }
    })).toThrow();

    expect(() => planningApiRequestSchema.parse({
      action: 'saveTrainingPlan',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'training-invalid-date-001',
        payload: {
          weekStartDate: '2025-02-29',
          businessTimezone: 'Asia/Shanghai',
          sessions: []
        }
      }
    })).toThrow();
  });

  it('accepts atomic setup without accepting a client userId', () => {
    const request = {
      action: 'completePlanningSetup',
      payload: {
        expectedVersions: { bodyProfile: 0, goal: 0, trainingPlan: 0 },
        idempotencyKey: 'setup-create-001',
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
    } as const;

    expect(planningApiRequestSchema.parse(request)).toEqual(request);
    expect(() => planningApiRequestSchema.parse({
      ...request,
      payload: { ...request.payload, userId: 'attacker-selected-user' }
    })).toThrow();
    expect(() => planningApiRequestSchema.parse({
      ...request,
      userId: 'attacker-selected-user'
    })).toThrow();
  });
});
