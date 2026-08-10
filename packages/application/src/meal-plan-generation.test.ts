import { describe, expect, test } from 'vitest';
import {
  TEST_DAILY_MENU_CATALOG,
  TEST_DAILY_MENU_TEMPLATES,
  TEST_NUTRITION_SNAPSHOTS,
  TEST_RECIPE_TEMPLATES
} from '@fitness/nutrition-fixtures';
import {
  ReviewedNutritionCache,
  StaticDailyMenuCatalogProvider,
  StaticRecipeTemplateProvider
} from '@fitness/providers';
import type {
  DailyMenuCatalogProvider,
  DailyMenuCatalogVersion,
  DailyMenuTemplateVersion,
  TrainingSessionPayload
} from '@fitness/domain';
import { InMemoryPlanningRepository } from '@fitness/persistence';
import {
  IdempotencyKeyReuseError,
  PlanningPrerequisiteError,
  VersionConflictError
} from './versioned-planning';
import {
  NutritionConstraintsInfeasibleError,
  ProviderUnavailableError,
  createMealPlanGenerationService,
  type MealPlanningProviders
} from './meal-plan-generation';

const NOW = '2026-08-10T00:00:00.000Z';
const WEEK_START = '2026-08-17';
const BALANCED_NUTRITION_SNAPSHOTS = TEST_NUTRITION_SNAPSHOTS.map((snapshot) => ({
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

function fixtureProviders(): MealPlanningProviders {
  return {
    nutrition: new ReviewedNutritionCache({
      mode: 'test',
      snapshots: BALANCED_NUTRITION_SNAPSHOTS
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
  };
}

function createHarness(options: {
  readonly repository?: InMemoryPlanningRepository;
  readonly providers?: MealPlanningProviders;
} = {}) {
  const repository = options.repository ?? new InMemoryPlanningRepository();
  let sequence = 0;
  const service = createMealPlanGenerationService({
    repository,
    providers: options.providers ?? fixtureProviders(),
    now: () => NOW,
    nextId: (prefix) => `${prefix}-${String(++sequence)}`
  });
  return { repository, service };
}

async function completeSetup(
  service: ReturnType<typeof createMealPlanGenerationService>,
  overrides: {
    readonly heightCm?: number;
    readonly weightKg?: number;
    readonly nonTrainingActivity?: 'light' | 'moderate' | 'heavy';
    readonly trainingSessions?: readonly TrainingSessionPayload[];
  } = {}
) {
  return service.completePlanningSetup('user-a', {
    expectedVersions: { bodyProfile: 0, goal: 0, trainingPlan: 0 },
    idempotencyKey: 'planning-setup-001',
    bodyProfile: {
      ageYears: 30,
      sexCode: 0,
      heightCm: overrides.heightCm ?? 175,
      weightKg: overrides.weightKg ?? 60,
      healthScopeConfirmed: true,
      nonTrainingActivity: overrides.nonTrainingActivity ?? 'light',
      allergens: [],
      avoidFoods: [],
      dietPreferences: [],
      businessTimezone: 'Asia/Shanghai'
    },
    goal: {
      goal: 'fat_loss',
      effectiveDate: '2026-08-10',
      targetDate: '2026-10-30'
    },
    trainingPlan: {
      weekStartDate: WEEK_START,
      businessTimezone: 'Asia/Shanghai',
      sessions: overrides.trainingSessions ?? []
    }
  });
}

function allFixtureInventory(availableGrams = 50_000) {
  return TEST_NUTRITION_SNAPSHOTS.map((snapshot) => ({
    name: snapshot.canonicalNameZh,
    availableGrams
  }));
}

async function saveFullInventory(
  service: ReturnType<typeof createMealPlanGenerationService>,
  idempotencyKey = 'inventory-save-001'
) {
  return service.saveInventory('user-a', {
    expectedVersion: 0,
    idempotencyKey,
    payload: { items: allFixtureInventory() }
  });
}

describe('meal plan generation application service', () => {
  test('resolves every name before saving a sorted inventory with duplicate food IDs merged', async () => {
    const { service } = createHarness();

    const saved = await service.saveInventory('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'inventory-save-001',
      payload: {
        items: [
          { name: ' 测试 米饭 ', availableGrams: 2000 },
          { name: '测试西兰花', availableGrams: 500 },
          { name: '测试米饭', availableGrams: 3000 }
        ]
      }
    });

    expect(saved).toMatchObject({
      version: 1,
      items: [
        { foodId: 'fixture-broccoli', availableGrams: 500 },
        { foodId: 'fixture-rice', availableGrams: 5000 }
      ]
    });
  });

  test('fails closed when a food name cannot be resolved without writing inventory', async () => {
    const { repository, service } = createHarness();

    await expect(service.saveInventory('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'inventory-unresolved-001',
      payload: { items: [{ name: '不存在的食材', availableGrams: 100 }] }
    })).rejects.toMatchObject({
      code: 'provider_unavailable',
      reason: 'food_name_unresolved'
    });
    expect((await repository.read('user-a')).inventories).toHaveLength(0);
  });

  test('rejects fixture source data when fixtures are disabled', async () => {
    const providers = { ...fixtureProviders(), allowTestFixtures: false };
    const { repository, service } = createHarness({ providers });

    await expect(service.saveInventory('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'inventory-source-001',
      payload: { items: [{ name: '测试米饭', availableGrams: 100 }] }
    })).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect((await repository.read('user-a')).inventories).toHaveLength(0);
  });

  test('replays the same normalized inventory command and rejects stale or reused writes', async () => {
    const { repository, service } = createHarness();
    const command = {
      expectedVersion: 0,
      idempotencyKey: 'inventory-replay-001',
      payload: { items: [{ name: '测试米饭', availableGrams: 5000 }] }
    } as const;

    const first = await service.saveInventory('user-a', command);
    await expect(service.saveInventory('user-a', command)).resolves.toEqual(first);
    await expect(service.saveInventory('user-a', {
      ...command,
      payload: { items: [{ name: '测试米饭', availableGrams: 4000 }] }
    })).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
    await expect(service.saveInventory('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'inventory-stale-001',
      payload: { items: [{ name: '测试米饭', availableGrams: 3000 }] }
    })).rejects.toBeInstanceOf(VersionConflictError);
    expect((await repository.read('user-a')).inventories).toHaveLength(1);
  });

  test('requires an active profile, goal, training plan, inventory, and seven feasible targets', async () => {
    const missing = createHarness();
    await expect(missing.service.generateWeeklyMealPlan('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'meal-generate-missing-001',
      payload: { weekStartDate: WEEK_START }
    })).rejects.toBeInstanceOf(PlanningPrerequisiteError);

    const infeasible = createHarness();
    await completeSetup(infeasible.service, { weightKg: 90 });
    await saveFullInventory(infeasible.service);
    await expect(infeasible.service.generateWeeklyMealPlan('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'meal-generate-infeasible-target-001',
      payload: { weekStartDate: WEEK_START }
    })).rejects.toBeInstanceOf(NutritionConstraintsInfeasibleError);
    expect((await infeasible.repository.read('user-a')).mealPlans).toHaveLength(0);
  });

  test('generates one deterministic complete weekly meal version and replays it atomically', async () => {
    const { repository, service } = createHarness();
    await completeSetup(service);
    const inventory = await saveFullInventory(service);
    const command = {
      expectedVersion: 0,
      idempotencyKey: 'meal-generate-001',
      payload: { weekStartDate: WEEK_START }
    } as const;

    const generated = await service.generateWeeklyMealPlan('user-a', command);
    await expect(service.generateWeeklyMealPlan('user-a', command)).resolves.toEqual(generated);

    expect(generated).toMatchObject({
      version: 1,
      readiness: 'complete',
      inventoryVersionId: inventory.id,
      generationPolicyVersion: 'weekly-meal-generation-v1'
    });
    expect(generated.days).toHaveLength(7);
    const state = await repository.read('user-a');
    expect(state.mealPlans).toHaveLength(1);
    expect(state.activeMealPlanVersionId).toBe(generated.id);
  });

  test('generates after one training day changes by retaining unaffected prior targets', async () => {
    const { repository, service } = createHarness();
    const setup = await completeSetup(service, {
      heightCm: 145,
      weightKg: 41,
      nonTrainingActivity: 'moderate',
      trainingSessions: [{
        businessDate: '2026-08-18',
        sessionCode: '02054',
        durationMinutes: 60
      }]
    });
    await saveFullInventory(service);
    const updatedTrainingPlan = await service.saveTrainingPlan('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'training-before-first-meal-002',
      payload: {
        weekStartDate: WEEK_START,
        businessTimezone: 'Asia/Shanghai',
        sessions: [{
          businessDate: '2026-08-18',
          sessionCode: '02050',
          durationMinutes: 30
        }]
      }
    });
    const beforeGeneration = await repository.read('user-a');
    const latestTargetsByDate = new Map<string, typeof beforeGeneration.dailyNutritionTargets[number]>();
    for (const target of beforeGeneration.dailyNutritionTargets) {
      const current = latestTargetsByDate.get(target.businessDate);
      if (current === undefined || target.version > current.version) {
        latestTargetsByDate.set(target.businessDate, target);
      }
    }
    const latestTargets = [...latestTargetsByDate.values()];
    expect(latestTargets.filter(
      (target) => target.trainingPlanVersionId === setup.trainingPlan.id
    )).toHaveLength(6);
    expect(latestTargets.filter(
      (target) => target.trainingPlanVersionId === updatedTrainingPlan.trainingPlan.id
    )).toHaveLength(1);

    const generated = await service.generateWeeklyMealPlan('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'meal-generate-after-training-change-001',
      payload: { weekStartDate: WEEK_START }
    });

    expect(generated.trainingPlanVersionId).toBe(updatedTrainingPlan.trainingPlan.id);
    expect(generated.days.map((day) => day.dailyNutritionTargetVersionId).sort()).toEqual(
      latestTargets.map((target) => target.id).sort()
    );
    expect((await repository.read('user-a')).activeMealPlanVersionId).toBe(generated.id);
  });

  test('does not partially write when deterministic generation is infeasible', async () => {
    const { repository, service } = createHarness();
    await completeSetup(service);
    await service.saveInventory('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'inventory-rice-only-001',
      payload: { items: [{ name: '测试米饭', availableGrams: 100 }] }
    });

    await expect(service.generateWeeklyMealPlan('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'meal-generate-no-inventory-001',
      payload: { weekStartDate: WEEK_START }
    })).rejects.toBeInstanceOf(NutritionConstraintsInfeasibleError);
    const state = await repository.read('user-a');
    expect(state.mealPlans).toHaveLength(0);
    expect(state.activeMealPlanVersionId).toBeNull();
  });

  test('does not partially write when a provider fails', async () => {
    const base = fixtureProviders();
    const providers: MealPlanningProviders = {
      ...base,
      menus: {
        getActiveCatalog: () => Promise.reject(new Error('offline')),
        getMenuByVersionId: (id) => base.menus.getMenuByVersionId(id)
      }
    };
    const { repository, service } = createHarness({ providers });
    await completeSetup(service);
    await saveFullInventory(service);

    await expect(service.generateWeeklyMealPlan('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'meal-generate-provider-failure-001',
      payload: { weekStartDate: WEEK_START }
    })).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect((await repository.read('user-a')).mealPlans).toHaveLength(0);
  });

  test('rejects the generation commit when inventory changes after provider loading begins', async () => {
    const repository = new InMemoryPlanningRepository();
    const base = fixtureProviders();
    const mutation = { run: (): Promise<void> => Promise.resolve() };
    let mutated = false;
    const menus: DailyMenuCatalogProvider = {
      async getActiveCatalog(): Promise<DailyMenuCatalogVersion> {
        if (!mutated) {
          mutated = true;
          await mutation.run();
        }
        return base.menus.getActiveCatalog();
      },
      getMenuByVersionId(id: string): Promise<DailyMenuTemplateVersion> {
        return base.menus.getMenuByVersionId(id);
      }
    };
    const { service } = createHarness({ repository, providers: { ...base, menus } });
    await completeSetup(service);
    await saveFullInventory(service);
    mutation.run = async () => {
      await service.saveInventory('user-a', {
        expectedVersion: 1,
        idempotencyKey: 'inventory-raced-002',
        payload: { items: allFixtureInventory(60_000) }
      });
    };

    await expect(service.generateWeeklyMealPlan('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'meal-generate-raced-001',
      payload: { weekStartDate: WEEK_START }
    })).rejects.toBeInstanceOf(VersionConflictError);
    const state = await repository.read('user-a');
    expect(state.inventories).toHaveLength(2);
    expect(state.mealPlans).toHaveLength(0);
  });

  test('rejects the generation commit when one daily target token changes after provider loading begins', async () => {
    const repository = new InMemoryPlanningRepository();
    const base = fixtureProviders();
    const mutation = { run: (): Promise<void> => Promise.resolve() };
    let mutated = false;
    const menus: DailyMenuCatalogProvider = {
      async getActiveCatalog(): Promise<DailyMenuCatalogVersion> {
        if (!mutated) {
          mutated = true;
          await mutation.run();
        }
        return base.menus.getActiveCatalog();
      },
      getMenuByVersionId(id: string): Promise<DailyMenuTemplateVersion> {
        return base.menus.getMenuByVersionId(id);
      }
    };
    const { service } = createHarness({ repository, providers: { ...base, menus } });
    await completeSetup(service);
    await saveFullInventory(service);
    const before = await repository.read('user-a');
    const previousNutrition = before.dailyNutritionTargets[0];
    if (previousNutrition === undefined) throw new Error('Expected a nutrition target');
    const previousEnergy = before.dailyEnergyTargets.find((target) => (
      target.id === previousNutrition.dailyEnergyTargetVersionId
    ));
    if (previousEnergy === undefined) throw new Error('Expected an energy target');
    mutation.run = async () => repository.transact('user-a', (state) => {
      const energy = {
        ...previousEnergy,
        id: 'daily-energy-target-raced',
        version: previousEnergy.version + 1
      };
      const nutrition = {
        ...previousNutrition,
        id: 'daily-nutrition-target-raced',
        version: previousNutrition.version + 1,
        dailyEnergyTargetVersionId: energy.id
      };
      return {
        nextState: {
          ...state,
          dailyEnergyTargets: [...state.dailyEnergyTargets, energy],
          dailyNutritionTargets: [...state.dailyNutritionTargets, nutrition]
        },
        result: undefined
      };
    });

    await expect(service.generateWeeklyMealPlan('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'meal-generate-target-raced-001',
      payload: { weekStartDate: WEEK_START }
    })).rejects.toBeInstanceOf(VersionConflictError);
    expect((await repository.read('user-a')).mealPlans).toHaveLength(0);
  });

  test('returns active inventory and meal plan with dynamic stale and phase-four counters', async () => {
    const { service } = createHarness();
    await completeSetup(service);
    const inventory = await saveFullInventory(service);
    const mealPlan = await service.generateWeeklyMealPlan('user-a', {
      expectedVersion: 0,
      idempotencyKey: 'meal-generate-context-001',
      payload: { weekStartDate: WEEK_START }
    });

    const current = await service.getCurrentContext('user-a');
    expect(current).toMatchObject({
      inventory: { id: inventory.id },
      mealPlan: { id: mealPlan.id },
      mealPlanStale: false,
      pendingMealPlanCandidate: null,
      pendingMealPlanTargetDiffs: [],
      latestVersions: { inventory: 1, mealPlan: 1 }
    });

    await service.saveTrainingPlan('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'training-context-change-002',
      payload: {
        weekStartDate: WEEK_START,
        businessTimezone: 'Asia/Shanghai',
        sessions: [{
          businessDate: '2026-08-18',
          sessionCode: '02054',
          durationMinutes: 45
        }]
      }
    });
    const stale = await service.getCurrentContext('user-a');
    expect(stale.mealPlan?.id).toBe(mealPlan.id);
    expect(stale.mealPlanStale).toBe(true);
    expect(stale.mealPlan).toEqual(mealPlan);
  });
});
