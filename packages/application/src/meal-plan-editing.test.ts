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
  MealPlanVersion,
  NutritionDataSnapshot,
  RecipeTemplateVersion
} from '@fitness/domain';
import { InMemoryPlanningRepository } from '@fitness/persistence';
import {
  IdempotencyKeyReuseError,
  VersionConflictError
} from './versioned-planning';
import {
  PastFactImmutableError,
  RecipeNotSelectableError,
  createMealPlanEditingService,
  selectManualMealReplacement,
  type MealPlanEditingServiceDependencies
} from './meal-plan-editing';

const NOW = '2026-08-10T00:00:00.000Z';
const WEEK_START = '2026-08-17';
const EDIT_DATE = '2026-08-19';
const REPLACEMENT_ID = 'recipe-version-fixture-day-2-dinner-v1';
const BALANCED_SNAPSHOTS: readonly NutritionDataSnapshot[] = TEST_NUTRITION_SNAPSHOTS.map(
  (snapshot) => ({
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
  })
);

function fixtureProviders(): MealPlanEditingServiceDependencies['providers'] {
  return {
    nutrition: new ReviewedNutritionCache({ mode: 'test', snapshots: BALANCED_SNAPSHOTS }),
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
  readonly providers?: MealPlanEditingServiceDependencies['providers'];
  readonly now?: string;
} = {}) {
  const repository = options.repository ?? new InMemoryPlanningRepository();
  let sequence = 0;
  const service = createMealPlanEditingService({
    repository,
    providers: options.providers ?? fixtureProviders(),
    now: () => options.now ?? NOW,
    nextId: (prefix) => `${prefix}-${String(++sequence)}`
  });
  return { repository, service };
}

async function prepareGeneratedPlan(
  harness: ReturnType<typeof createHarness>,
  profileOverrides: {
    readonly allergens?: readonly string[];
    readonly avoidFoods?: readonly string[];
  } = {}
): Promise<MealPlanVersion> {
  await harness.service.completePlanningSetup('user-a', {
    expectedVersions: { bodyProfile: 0, goal: 0, trainingPlan: 0 },
    idempotencyKey: 'planning-setup-001',
    bodyProfile: {
      ageYears: 30,
      sexCode: 0,
      heightCm: 175,
      weightKg: 60,
      healthScopeConfirmed: true,
      nonTrainingActivity: 'light',
      allergens: profileOverrides.allergens ?? [],
      avoidFoods: profileOverrides.avoidFoods ?? [],
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
      sessions: []
    }
  });
  await harness.service.saveInventory('user-a', {
    expectedVersion: 0,
    idempotencyKey: 'inventory-save-001',
    payload: {
      items: BALANCED_SNAPSHOTS.map((snapshot) => ({
        name: snapshot.canonicalNameZh,
        availableGrams: 50_000
      }))
    }
  });
  return harness.service.generateWeeklyMealPlan('user-a', {
    expectedVersion: 0,
    idempotencyKey: 'meal-generate-001',
    payload: { weekStartDate: WEEK_START }
  });
}

async function selectorInput() {
  const harness = createHarness();
  const currentPlan = await prepareGeneratedPlan(harness);
  const state = await harness.repository.read('user-a');
  const inventory = state.inventories[0];
  const target = state.dailyNutritionTargets.find(
    (candidate) => candidate.businessDate === EDIT_DATE
  );
  const replacementRecipe = TEST_RECIPE_TEMPLATES.find(
    (candidate) => candidate.id === REPLACEMENT_ID
  );
  if (inventory === undefined || target === undefined || replacementRecipe === undefined) {
    throw new Error('Expected complete selector fixture');
  }
  return {
    currentPlan,
    businessDate: EDIT_DATE,
    slot: 'dinner' as const,
    replacementRecipe,
    recipes: TEST_RECIPE_TEMPLATES,
    snapshots: BALANCED_SNAPSHOTS,
    inventory,
    target,
    allergens: [] as readonly string[],
    avoidFoodIds: [] as readonly string[],
    allowTestFixtures: true
  };
}

describe('meal plan day locking', () => {
  test('creates an immutable complete successor for one future day and replays it', async () => {
    const harness = createHarness();
    const original = await prepareGeneratedPlan(harness);
    const originalCopy = structuredClone(original);
    const command = {
      expectedVersion: 1,
      idempotencyKey: 'meal-lock-001',
      payload: { businessDate: EDIT_DATE, locked: true }
    } as const;

    const locked = await harness.service.setMealPlanDayLock('user-a', command);
    const replay = await harness.service.setMealPlanDayLock('user-a', command);

    expect(replay).toEqual(locked);
    expect(locked).toMatchObject({
      version: 2,
      readiness: 'complete',
      supersedesVersionId: original.id
    });
    expect(locked.days.filter((day, index) => (
      JSON.stringify(day) !== JSON.stringify(original.days[index])
    ))).toEqual([
      expect.objectContaining({ businessDate: EDIT_DATE, locked: true })
    ]);
    expect(original).toEqual(originalCopy);
    const state = await harness.repository.read('user-a');
    expect(state.mealPlans).toHaveLength(2);
    expect(state.activeMealPlanVersionId).toBe(locked.id);
  });

  test('unlocking preserves the manually-modified historical fact', async () => {
    const harness = createHarness();
    await prepareGeneratedPlan(harness);
    const edited = await harness.service.updateMealPlanDay('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'meal-edit-before-unlock-001',
      payload: {
        businessDate: EDIT_DATE,
        slot: 'dinner',
        recipeTemplateVersionId: REPLACEMENT_ID
      }
    });

    const unlocked = await harness.service.setMealPlanDayLock('user-a', {
      expectedVersion: 2,
      idempotencyKey: 'meal-unlock-001',
      payload: { businessDate: EDIT_DATE, locked: false }
    });

    expect(edited.days.find((day) => day.businessDate === EDIT_DATE)).toMatchObject({
      locked: true,
      manuallyModified: true
    });
    expect(unlocked.days.find((day) => day.businessDate === EDIT_DATE)).toMatchObject({
      locked: false,
      manuallyModified: true
    });
  });

  test('locking changes no top-level planning reference after inventory advances', async () => {
    const harness = createHarness();
    const original = await prepareGeneratedPlan(harness);
    await harness.service.saveInventory('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'inventory-before-lock-002',
      payload: {
        items: BALANCED_SNAPSHOTS.map((snapshot) => ({
          name: snapshot.canonicalNameZh,
          availableGrams: 60_000
        }))
      }
    });

    const locked = await harness.service.setMealPlanDayLock('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'meal-lock-after-inventory-001',
      payload: { businessDate: EDIT_DATE, locked: true }
    });

    expect(locked.inventoryVersionId).toBe(original.inventoryVersionId);
    expect(locked.catalogVersionId).toBe(original.catalogVersionId);
    expect(locked.trainingPlanVersionId).toBe(original.trainingPlanVersionId);
  });

  test.each(['2026-08-09', '2026-08-10'])(
    'rejects server-time past/today boundary %s without writing',
    async (businessDate) => {
      const harness = createHarness();
      await prepareGeneratedPlan(harness);
      const before = await harness.repository.read('user-a');

      await expect(harness.service.setMealPlanDayLock('user-a', {
        expectedVersion: 1,
        idempotencyKey: `meal-past-${businessDate}`,
        payload: { businessDate, locked: true }
      })).rejects.toBeInstanceOf(PastFactImmutableError);
      expect(await harness.repository.read('user-a')).toEqual(before);
    }
  );

  test('uses the stored business timezone at the server instant for manual edits', async () => {
    const harness = createHarness({ now: '2026-08-09T16:30:00.000Z' });
    await prepareGeneratedPlan(harness);
    const before = await harness.repository.read('user-a');

    await expect(harness.service.updateMealPlanDay('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'meal-edit-timezone-boundary-001',
      payload: {
        businessDate: '2026-08-10',
        slot: 'dinner',
        recipeTemplateVersionId: REPLACEMENT_ID
      }
    })).rejects.toBeInstanceOf(PastFactImmutableError);
    expect(await harness.repository.read('user-a')).toEqual(before);
  });
});

describe('manual meal replacement selection', () => {
  test('replaces exactly one slot on the exact multiplier grid and recomputes the day', async () => {
    const input = await selectorInput();
    const previousDay = input.currentPlan.days.find((day) => day.businessDate === EDIT_DATE);
    if (previousDay === undefined) throw new Error('Expected edit day');

    const selected = selectManualMealReplacement(input);

    expect(selected).not.toHaveProperty('kind');
    if ('kind' in selected) throw new Error('Expected a selected day');
    expect(selected.meals.filter((meal) => meal.slot !== 'dinner')).toEqual(
      previousDay.meals.filter((meal) => meal.slot !== 'dinner')
    );
    expect(selected.meals.find((meal) => meal.slot === 'dinner')).toMatchObject({
      recipeTemplateVersionId: REPLACEMENT_ID,
      servingMultiplier: 1.05
    });
    expect(selected.locked).toBe(true);
    expect(selected.manuallyModified).toBe(true);
    expect(selected.ingredientAmounts).not.toEqual(previousDay.ingredientAmounts);
  });

  test.each([
    {
      name: 'allergen',
      mutate: (input: Awaited<ReturnType<typeof selectorInput>>) => ({
        ...input,
        allergens: ['鱼类']
      }),
      code: 'allergen_detected'
    },
    {
      name: 'avoided food',
      mutate: (input: Awaited<ReturnType<typeof selectorInput>>) => ({
        ...input,
        avoidFoodIds: ['fixture-fish']
      }),
      code: 'avoided_food'
    },
    {
      name: 'missing source',
      mutate: (input: Awaited<ReturnType<typeof selectorInput>>) => ({
        ...input,
        snapshots: input.snapshots.filter((snapshot) => snapshot.foodId !== 'fixture-fish')
      }),
      code: 'source_chain_incomplete'
    },
    {
      name: 'whole-week inventory exhaustion',
      mutate: (input: Awaited<ReturnType<typeof selectorInput>>) => ({
        ...input,
        inventory: {
          ...input.inventory,
          items: input.inventory.items.map((item) => item.foodId === 'fixture-fish'
            ? { ...item, availableGrams: 0.1 }
            : item)
        }
      }),
      code: 'inventory_insufficient'
    },
    {
      name: 'daily nutrition infeasibility',
      mutate: (input: Awaited<ReturnType<typeof selectorInput>>) => {
        const oversized = {
          ...input.replacementRecipe,
          ingredients: input.replacementRecipe.ingredients.map((ingredient) => ({
            ...ingredient,
            grams: 5_000
          }))
        };
        return {
          ...input,
          replacementRecipe: oversized,
          recipes: input.recipes.map((recipe) => recipe.id === oversized.id ? oversized : recipe)
        };
      },
      code: 'nutrition_out_of_range'
    },
    {
      name: 'an ingredient rounded to zero grams',
      mutate: (input: Awaited<ReturnType<typeof selectorInput>>) => {
        const zeroRounded = {
          ...input.replacementRecipe,
          ingredients: input.replacementRecipe.ingredients.map((ingredient, index) => (
            index === 0 ? { ...ingredient, grams: 0.01 } : ingredient
          ))
        };
        return {
          ...input,
          replacementRecipe: zeroRounded,
          recipes: input.recipes.map((recipe) => (
            recipe.id === zeroRounded.id ? zeroRounded : recipe
          ))
        };
      },
      code: 'food_diversity_insufficient'
    }
  ])('fails closed for $name without changing another meal', async ({ mutate, code }) => {
    const input = mutate(await selectorInput());
    const result = selectManualMealReplacement(input);

    expect(result).toHaveProperty('kind', 'infeasible');
    if (!('kind' in result)) throw new Error('Expected structured infeasibility');
    expect(result.code).toBe('nutrition_constraints_infeasible');
    expect(result.conflicts.some((conflict) => conflict.code === code)).toBe(true);
  });
});

describe('manual meal edit transaction', () => {
  test('writes one complete successor, locks the edited day, and keeps the old plan immutable', async () => {
    const harness = createHarness();
    const original = await prepareGeneratedPlan(harness);
    const originalCopy = structuredClone(original);

    const edited = await harness.service.updateMealPlanDay('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'meal-edit-001',
      payload: {
        businessDate: EDIT_DATE,
        slot: 'dinner',
        recipeTemplateVersionId: REPLACEMENT_ID
      }
    });

    expect(edited).toMatchObject({
      version: 2,
      readiness: 'complete',
      supersedesVersionId: original.id
    });
    const editedDay = edited.days.find((day) => day.businessDate === EDIT_DATE);
    expect(editedDay).toMatchObject({
      locked: true,
      manuallyModified: true
    });
    expect(editedDay?.meals.find((meal) => meal.slot === 'dinner')).toMatchObject({
      recipeTemplateVersionId: REPLACEMENT_ID
    });
    expect(original).toEqual(originalCopy);
  });

  test('rejects a recipe outside the server catalog and conflicting idempotent replay', async () => {
    const harness = createHarness();
    await prepareGeneratedPlan(harness);
    const command = {
      expectedVersion: 1,
      idempotencyKey: 'meal-edit-replay-001',
      payload: {
        businessDate: EDIT_DATE,
        slot: 'dinner' as const,
        recipeTemplateVersionId: REPLACEMENT_ID
      }
    };
    const edited = await harness.service.updateMealPlanDay('user-a', command);
    await expect(harness.service.updateMealPlanDay('user-a', command)).resolves.toEqual(edited);
    await expect(harness.service.updateMealPlanDay('user-a', {
      ...command,
      payload: { ...command.payload, slot: 'lunch' }
    })).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
    await expect(harness.service.updateMealPlanDay('user-a', {
      expectedVersion: 2,
      idempotencyKey: 'meal-edit-unlisted-001',
      payload: {
        businessDate: '2026-08-20',
        slot: 'dinner',
        recipeTemplateVersionId: 'client-invented-recipe'
      }
    })).rejects.toBeInstanceOf(RecipeNotSelectableError);
    expect((await harness.repository.read('user-a')).mealPlans).toHaveLength(2);
  });

  test('provider or nutrient failure leaves plan, active pointer, and idempotency state unchanged', async () => {
    const base = fixtureProviders();
    let offline = false;
    const providers: MealPlanEditingServiceDependencies['providers'] = {
      ...base,
      menus: {
        getActiveCatalog: () => offline
          ? Promise.reject(new Error('offline'))
          : base.menus.getActiveCatalog(),
        getMenuByVersionId: (id) => base.menus.getMenuByVersionId(id)
      }
    };
    const harness = createHarness({ providers });
    await prepareGeneratedPlan(harness);
    offline = true;
    const before = await harness.repository.read('user-a');

    await expect(harness.service.updateMealPlanDay('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'meal-edit-provider-failure-001',
      payload: {
        businessDate: EDIT_DATE,
        slot: 'dinner',
        recipeTemplateVersionId: REPLACEMENT_ID
      }
    })).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(await harness.repository.read('user-a')).toEqual(before);
  });

  test('a nutrition-infeasible provider replacement rolls back the whole write', async () => {
    const base = fixtureProviders();
    let oversized = false;
    const providers: MealPlanEditingServiceDependencies['providers'] = {
      ...base,
      recipes: {
        async getByVersionId(id: string): Promise<RecipeTemplateVersion> {
          const recipe = await base.recipes.getByVersionId(id);
          return oversized && id === REPLACEMENT_ID
            ? {
                ...recipe,
                ingredients: recipe.ingredients.map((ingredient) => ({
                  ...ingredient,
                  grams: 5_000
                }))
              }
            : recipe;
        }
      }
    };
    const harness = createHarness({ providers });
    await prepareGeneratedPlan(harness);
    oversized = true;
    const before = await harness.repository.read('user-a');

    await expect(harness.service.updateMealPlanDay('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'meal-edit-infeasible-001',
      payload: {
        businessDate: EDIT_DATE,
        slot: 'dinner',
        recipeTemplateVersionId: REPLACEMENT_ID
      }
    })).rejects.toMatchObject({ code: 'nutrition_constraints_infeasible' });
    expect(await harness.repository.read('user-a')).toEqual(before);
  });

  test('rejects an active-plan race without a partial edit', async () => {
    const repository = new InMemoryPlanningRepository();
    const base = fixtureProviders();
    const mutation = { run: (): Promise<void> => Promise.resolve() };
    let armed = false;
    const menus: DailyMenuCatalogProvider = {
      async getActiveCatalog(): Promise<DailyMenuCatalogVersion> {
        if (armed) {
          armed = false;
          await mutation.run();
        }
        return base.menus.getActiveCatalog();
      },
      getMenuByVersionId(id: string): Promise<DailyMenuTemplateVersion> {
        return base.menus.getMenuByVersionId(id);
      }
    };
    const harness = createHarness({ repository, providers: { ...base, menus } });
    await prepareGeneratedPlan(harness);
    mutation.run = async () => {
      await harness.service.setMealPlanDayLock('user-a', {
        expectedVersion: 1,
        idempotencyKey: 'meal-race-lock-001',
        payload: { businessDate: '2026-08-18', locked: true }
      });
    };
    armed = true;

    await expect(harness.service.updateMealPlanDay('user-a', {
      expectedVersion: 1,
      idempotencyKey: 'meal-edit-raced-plan-001',
      payload: {
        businessDate: EDIT_DATE,
        slot: 'dinner',
        recipeTemplateVersionId: REPLACEMENT_ID
      }
    })).rejects.toBeInstanceOf(VersionConflictError);
    const state = await repository.read('user-a');
    expect(state.mealPlans).toHaveLength(2);
    expect(state.idempotencyRecords.some((record) => (
      record.operation === 'updateMealPlanDay'
    ))).toBe(false);
  });

  test('rejects inventory and target token races without writing a successor', async () => {
    for (const race of ['inventory', 'target'] as const) {
      const repository = new InMemoryPlanningRepository();
      const base = fixtureProviders();
      const mutation = { run: (): Promise<void> => Promise.resolve() };
      let armed = false;
      const menus: DailyMenuCatalogProvider = {
        async getActiveCatalog(): Promise<DailyMenuCatalogVersion> {
          if (armed) {
            armed = false;
            await mutation.run();
          }
          return base.menus.getActiveCatalog();
        },
        getMenuByVersionId(id: string): Promise<DailyMenuTemplateVersion> {
          return base.menus.getMenuByVersionId(id);
        }
      };
      const harness = createHarness({ repository, providers: { ...base, menus } });
      await prepareGeneratedPlan(harness);
      if (race === 'inventory') {
        mutation.run = async () => {
          await harness.service.saveInventory('user-a', {
            expectedVersion: 1,
            idempotencyKey: 'inventory-race-edit-001',
            payload: {
              items: BALANCED_SNAPSHOTS.map((snapshot) => ({
                name: snapshot.canonicalNameZh,
                availableGrams: 60_000
              }))
            }
          });
        };
      } else {
        mutation.run = async () => repository.transact('user-a', (state) => {
          const previous = state.dailyNutritionTargets.find(
            (candidate) => candidate.businessDate === EDIT_DATE
          );
          const energy = previous === undefined
            ? undefined
            : state.dailyEnergyTargets.find(
              (candidate) => candidate.id === previous.dailyEnergyTargetVersionId
            );
          if (previous === undefined || energy === undefined) {
            throw new Error('Expected target race fixture');
          }
          const nextEnergy = {
            ...energy,
            id: 'daily-energy-target-edit-race',
            version: energy.version + 1
          };
          const nextNutrition = {
            ...previous,
            id: 'daily-nutrition-target-edit-race',
            version: previous.version + 1,
            dailyEnergyTargetVersionId: nextEnergy.id
          };
          return {
            nextState: {
              ...state,
              dailyEnergyTargets: [...state.dailyEnergyTargets, nextEnergy],
              dailyNutritionTargets: [...state.dailyNutritionTargets, nextNutrition]
            },
            result: undefined
          };
        });
      }
      armed = true;

      await expect(harness.service.updateMealPlanDay('user-a', {
        expectedVersion: 1,
        idempotencyKey: `meal-edit-${race}-race-001`,
        payload: {
          businessDate: EDIT_DATE,
          slot: 'dinner',
          recipeTemplateVersionId: REPLACEMENT_ID
        }
      })).rejects.toBeInstanceOf(VersionConflictError);
      const state = await repository.read('user-a');
      expect(state.mealPlans).toHaveLength(1);
      expect(state.idempotencyRecords.some((record) => (
        record.operation === 'updateMealPlanDay'
      ))).toBe(false);
    }
  });

  test('current context exposes only server-provided recipe IDs and Chinese names', async () => {
    const harness = createHarness();
    await prepareGeneratedPlan(harness);

    const context = await harness.service.getCurrentContext('user-a');

    expect(context.selectableRecipes).toContainEqual({
      recipeTemplateVersionId: REPLACEMENT_ID,
      dishNameZh: '测试第2日dinner'
    });
    expect(context.selectableRecipes.every((recipe) => (
      Object.keys(recipe).sort().join(',') === 'dishNameZh,recipeTemplateVersionId'
    ))).toBe(true);
  });
});
