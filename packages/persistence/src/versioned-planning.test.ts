import { describe, expect, test } from 'vitest';
import {
  IdempotencyKeyReuseError,
  InvalidGoalError,
  PastTrainingChangeError,
  PlanningPrerequisiteError,
  VersionConflictError,
  createMealPlanEditingService,
  createMealPlanGenerationService,
  createVersionedPlanningService
} from '@fitness/application';
import type { CompletePlanningSetupCommand, NutritionDataSnapshot } from '@fitness/domain';
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

const reviewedRiceSnapshot: NutritionDataSnapshot = {
  id: 'snapshot-rice-reviewed-v1',
  foodId: 'rice-reviewed',
  canonicalNameZh: '审核米饭',
  foodGroupId: 'grains_tubers',
  sourceId: 'reviewed-source',
  sourceRecordId: 'reviewed-rice-1',
  provider: 'reviewed-cache',
  originalUnit: 'per_100_g_edible_portion',
  foodState: 'cooked',
  datasetVersion: 'reviewed-v1',
  snapshotVersion: 1,
  reviewedAt: '2026-08-01T00:00:00.000Z',
  qualityStatus: 'reviewed',
  allergens: [],
  nutrientsPer100g: {
    energyKcal: 116,
    proteinG: 2.6,
    fatG: 0.3,
    carbohydrateG: 25.9,
    fiberG: 0.3,
    saturatedFatG: 0.1,
    addedSugarG: 0
  }
};

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
  test('persists a lock successor atomically without changing the prior meal plan', async () => {
    const repository = new InMemoryPlanningRepository();
    let nextId = 0;
    const unavailable = () => Promise.reject(new Error('not needed for lock test'));
    const service = createMealPlanEditingService({
      repository,
      now: () => '2026-08-03T08:00:00.000Z',
      nextId: (prefix) => `${prefix}-${String(++nextId)}`,
      providers: {
        nutrition: { getSnapshot: unavailable, resolveCanonicalName: unavailable },
        recipes: { getByVersionId: unavailable },
        menus: { getActiveCatalog: unavailable, getMenuByVersionId: unavailable },
        allowTestFixtures: false
      }
    });
    const setup = await service.completePlanningSetup('user-a', planningSetup());
    await repository.transact('user-a', (state) => {
      const inventory = {
        kind: 'inventory_version' as const,
        id: 'inventory-lock-test-1',
        userId: 'user-a',
        version: 1,
        createdAt: '2026-08-03T08:00:00.000Z',
        items: [{
          foodId: 'food-lock-test',
          nutritionSnapshotId: 'snapshot-lock-test-v1',
          availableGrams: 1_000
        }]
      };
      const targetByDate = new Map(
        setup.dailyNutritionTargets.map((target) => [target.businessDate, target])
      );
      const mealPlan = {
        kind: 'meal_plan_version' as const,
        id: 'meal-plan-lock-test-1',
        userId: 'user-a',
        version: 1,
        createdAt: '2026-08-03T08:00:00.000Z',
        weekStartDate: '2026-08-10',
        bodyProfileVersionId: setup.bodyProfile.id,
        goalVersionId: setup.goal.id,
        trainingPlanVersionId: setup.trainingPlan.id,
        inventoryVersionId: inventory.id,
        catalogVersionId: 'catalog-lock-test-v1',
        generationPolicyVersion: 'weekly-meal-generation-v1' as const,
        supersedesVersionId: null,
        readiness: 'complete' as const,
        days: Array.from({ length: 7 }, (_, index) => {
          const businessDate = `2026-08-${String(10 + index).padStart(2, '0')}`;
          const target = targetByDate.get(businessDate);
          if (target === undefined) throw new Error('Expected target for lock test');
          return {
            businessDate,
            dailyNutritionTargetVersionId: target.id,
            dailyMenuTemplateVersionId: 'daily-menu-lock-test-v1',
            locked: false,
            manuallyModified: false,
            meals: [{
              slot: 'breakfast' as const,
              recipeTemplateVersionId: 'recipe-lock-test-v1',
              servingMultiplier: 1
            }],
            ingredientAmounts: [{ foodId: 'food-lock-test', grams: 100 }],
            nutritionTotals: {
              energyKcal: 100,
              proteinG: 10,
              fatG: 5,
              carbohydrateG: 12,
              fiberG: 3,
              saturatedFatG: 1,
              addedSugarG: 0
            },
            nutritionSourceSnapshotIds: ['snapshot-lock-test-v1']
          };
        })
      };
      return {
        nextState: {
          ...state,
          inventories: [inventory],
          mealPlans: [mealPlan],
          activeInventoryVersionId: inventory.id,
          activeMealPlanVersionId: mealPlan.id
        },
        result: undefined
      };
    });
    const before = await repository.read('user-a');

    const locked = await service.setMealPlanDayLock('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'meal-lock-persistence-001',
      payload: { businessDate: '2026-08-11', locked: true }
    });
    const after = await repository.read('user-a');

    expect(after.mealPlans[0]).toEqual(before.mealPlans[0]);
    expect(after.mealPlans).toHaveLength(2);
    expect(after.activeMealPlanVersionId).toBe(locked.id);
    expect(locked.days.find((day) => day.businessDate === '2026-08-11')?.locked).toBe(true);
  });

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
    expect(result.dailyNutritionTargets).toHaveLength(7);
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
    for (const [index, target] of result.dailyNutritionTargets.entries()) {
      const energyTarget = result.dailyEnergyTargets[index];
      if (energyTarget === undefined) throw new Error('Expected paired energy target');
      expect(target).toEqual(expect.objectContaining({
        dailyEnergyTargetVersionId: energyTarget.id,
        businessDate: energyTarget.businessDate,
        bodyProfileVersionId: profile.id,
        goalVersionId: goal.id,
        trainingPlanVersionId: result.trainingPlan.id,
        energyPolicyVersion: 'calculation-policy-v2',
        nutritionPolicyVersion: 'nutrition-policy-v1'
      }));
    }
    expect(result.dailyNutritionTargets[1]?.nutrition).toMatchObject({
      kind: 'feasible',
      proteinG: 112
    });

    const state = await repository.read('user-a');
    expect(state.dailyEnergyTargets).toHaveLength(7);
    expect(state.dailyNutritionTargets).toHaveLength(7);
    expect(await service.getCurrentContext('user-b')).toEqual({
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
    expect(result.dailyNutritionTargets).toHaveLength(7);
    expect(result.affectedDates).toEqual([
      '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13',
      '2026-08-14', '2026-08-15', '2026-08-16'
    ]);
    expect(state.bodyProfiles).toHaveLength(1);
    expect(state.goals).toHaveLength(1);
    expect(state.trainingPlans).toHaveLength(1);
    expect(state.dailyEnergyTargets).toHaveLength(7);
    expect(state.dailyNutritionTargets).toHaveLength(7);
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
    const stateBefore = await repository.read('user-a');
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

    expect(await repository.read('user-a')).toEqual(stateBefore);
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
    expect(state.dailyNutritionTargets).toHaveLength(7);
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
        bodyProfile: 2,
        goal: 1,
        trainingPlan: 1,
        inventory: 0,
        mealPlan: 0,
        mealPlanDecision: 0,
        trainingCompletion: 0,
        recalculationJob: 0,
        ingredientPhoto: 0
      }
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
        bodyProfile: 1,
        goal: 2,
        trainingPlan: 1,
        inventory: 0,
        mealPlan: 0,
        mealPlanDecision: 0,
        trainingCompletion: 0,
        recalculationJob: 0,
        ingredientPhoto: 0
      }
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
    expect(changed.dailyNutritionTargets.map((target) => target.businessDate))
      .toEqual(['2026-08-11', '2026-08-13']);
    expect(state.dailyEnergyTargets).toHaveLength(9);
    expect(state.dailyNutritionTargets).toHaveLength(9);
    expect(state.outboxEvents.at(-1)).toEqual(expect.objectContaining({
      previousTrainingPlanVersionId: setup.trainingPlan.id,
      trainingPlanVersionId: changed.trainingPlan.id,
      affectedDates: ['2026-08-11', '2026-08-13']
    }));
    expect(state.recalculationJobs).toHaveLength(1);
    expect(state.recalculationJobs[0]).toEqual(expect.objectContaining({
      triggerEventId: state.outboxEvents.at(-1)?.eventId,
      triggerType: 'training_plan_changed',
      affectedDates: ['2026-08-11', '2026-08-13'],
      status: 'pending'
    }));
    const context = await service.getCurrentContext('user-a');
    expect(context.dailyEnergyTargets).toHaveLength(7);
    expect(context.dailyNutritionTargets).toHaveLength(7);
    expect(context.dailyEnergyTargets.find((target) => target.businessDate === '2026-08-11')
      ?.trainingPlanVersionId).toBe(changed.trainingPlan.id);
    expect(context.dailyEnergyTargets.find((target) => target.businessDate === '2026-08-12')
      ?.trainingPlanVersionId).toBe(setup.trainingPlan.id);
    expect(context.dailyNutritionTargets.find((target) => target.businessDate === '2026-08-11')
      ?.trainingPlanVersionId).toBe(changed.trainingPlan.id);
    expect(context.dailyNutritionTargets.find((target) => target.businessDate === '2026-08-12')
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
    expect(result.dailyNutritionTargets.map((target) => target.businessDate))
      .toEqual(['2026-08-12', '2026-08-13', '2026-08-14']);
  });

  test('records null nutrition without inventing a target for an unsupported profile', async () => {
    const { service } = createHarness('2026-08-07T00:00:00.000Z');
    const result = await service.completePlanningSetup('user-a', planningSetup({
      bodyProfile: { ...profilePayload, ageYears: 46 }
    }));

    expect(result.dailyNutritionTargets).toHaveLength(7);
    expect(result.dailyNutritionTargets.every((target) => (
      target.energy.kind === 'unsupported' && target.nutrition === null
    ))).toBe(true);
  });

  test('persists and replays an immutable inventory version through the repository transaction', async () => {
    const repository = new InMemoryPlanningRepository();
    let sequence = 0;
    const service = createMealPlanGenerationService({
      repository,
      now: () => '2026-08-10T00:00:00.000Z',
      nextId: (prefix) => `${prefix}-${String(++sequence)}`,
      providers: {
        allowTestFixtures: false,
        nutrition: {
          getSnapshot: (id) => id === reviewedRiceSnapshot.id
            ? Promise.resolve(structuredClone(reviewedRiceSnapshot))
            : Promise.reject(new Error('missing snapshot')),
          resolveCanonicalName: (name) => name.trim() === reviewedRiceSnapshot.canonicalNameZh
            ? Promise.resolve({
                foodId: reviewedRiceSnapshot.foodId,
                canonicalNameZh: reviewedRiceSnapshot.canonicalNameZh,
                nutritionSnapshotId: reviewedRiceSnapshot.id
              })
            : Promise.resolve(null)
        },
        recipes: {
          getByVersionId: () => Promise.reject(new Error('unused'))
        },
        menus: {
          getActiveCatalog: () => Promise.reject(new Error('unused')),
          getMenuByVersionId: () => Promise.reject(new Error('unused'))
        }
      }
    });
    const command = {
      expectedVersion: 0,
      idempotencyKey: 'inventory-persistence-001',
      payload: { items: [{ name: '审核米饭', availableGrams: 5000 }] }
    } as const;

    const first = await service.saveInventory('user-a', command);
    const replay = await service.saveInventory('user-a', command);
    const state = await repository.read('user-a');

    expect(replay).toEqual(first);
    expect(state.inventories).toEqual([first]);
    expect(state.activeInventoryVersionId).toBe(first.id);
    expect(state.idempotencyRecords.at(-1)).toMatchObject({
      operation: 'saveInventory',
      resultVersionId: first.id
    });
  });
});
