import { describe, expect, it } from 'vitest';
import type {
  DailyMenuCatalogVersion,
  DailyMenuTemplateVersion,
  DailyNutritionTargetVersion,
  FoodGroupId,
  InventoryVersion,
  NutrientValues,
  NutritionDataSnapshot,
  RecipeTemplateVersion
} from '@fitness/domain';
import { NUTRITION_POLICY_V1 } from './nutrition-policy';
import {
  FOOD_DIVERSITY_POLICY_V1,
  MEAL_PLAN_VALIDATION_V1,
  WEEKLY_MEAL_GENERATION_V1,
  WEEKLY_MEAL_SERVING_MULTIPLIERS
} from './meal-plan-policy';
import { generateWeeklyMealPlan } from './generate-weekly-meal-plan';

const WEEK_START_DATE = '2026-08-17';
const CORE_GROUPS = [
  'grains_tubers',
  'vegetables',
  'fruit',
  'animal_protein',
  'soy_nuts',
  'dairy'
] as const satisfies readonly FoodGroupId[];
const ZERO_NUTRIENTS: NutrientValues = {
  energyKcal: 0,
  proteinG: 0,
  fatG: 0,
  carbohydrateG: 0,
  fiberG: 0,
  saturatedFatG: 0,
  addedSugarG: 0
};
const BALANCED_TOTALS: NutrientValues = {
  energyKcal: 1_920,
  proteinG: 60,
  fatG: 55,
  carbohydrateG: 288,
  fiberG: 26,
  saturatedFatG: 5,
  addedSugarG: 0
};

interface TestFood {
  readonly id: string;
  readonly group: FoodGroupId;
  readonly nutrients: NutrientValues;
  readonly allergens?: readonly string[] | undefined;
}

interface TestMenuDefinition {
  readonly id: string;
  readonly foods: readonly TestFood[];
  readonly grams?: number | undefined;
}

interface TestMealFixture {
  readonly catalog: DailyMenuCatalogVersion;
  readonly menus: readonly DailyMenuTemplateVersion[];
  readonly recipes: readonly RecipeTemplateVersion[];
  readonly snapshots: readonly NutritionDataSnapshot[];
}

function addBusinessDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function makeTarget(
  dayIndex: number,
  targetEnergyKcal = 1_920,
  proteinG = 60
): DailyNutritionTargetVersion {
  const businessDate = addBusinessDays(WEEK_START_DATE, dayIndex);
  return {
    kind: 'daily_nutrition_target_version',
    id: `nutrition-target-${businessDate}`,
    userId: 'user-test',
    version: dayIndex + 1,
    createdAt: '2026-08-10T00:00:00.000Z',
    businessDate,
    bodyProfileVersionId: 'body-v1',
    goalVersionId: 'goal-v1',
    trainingPlanVersionId: 'training-v1',
    dailyEnergyTargetVersionId: `energy-target-${businessDate}`,
    energyPolicyVersion: 'calculation-policy-v2',
    nutritionPolicyVersion: 'nutrition-policy-v1',
    energy: {
      kind: 'supported',
      bmi: 22,
      estimatedBmrKcal: 1_400,
      nonTrainingBaselineKcal: 1_800,
      trainingNetKcal: 120,
      estimatedMaintenanceKcal: 1_920,
      targetEnergyKcal,
      policy: {
        policyVersion: 'calculation-policy-v2',
        sourceIds: ['CN-BMR-2023'],
        applicableAgeRange: { minInclusive: 18, maxInclusive: 45 },
        applicableBmiRange: { minInclusive: 18.5, maxExclusive: 24 },
        rounding: { kcal: 'nearest_whole_half_up', bmi: 'nearest_hundredth_half_up' }
      },
      disclaimer: 'test estimate'
    },
    nutrition: {
      kind: 'feasible',
      targetEnergyKcal,
      proteinG,
      fatG: Math.round(targetEnergyKcal * 0.25 / 9 * 10) / 10,
      carbohydrateG: Math.round(targetEnergyKcal * 0.6 / 4 * 10) / 10,
      proteinEnergyPercent: Math.round(proteinG * 4 / targetEnergyKcal * 1_000) / 10,
      fatEnergyPercent: 25,
      carbohydrateEnergyPercent: 60,
      fiberRangeG: { minInclusive: 25, maxInclusive: 30 },
      saturatedFatMaxExclusiveG: Math.floor(targetEnergyKcal * 0.1 / 9 * 10) / 10,
      addedSugarMaxExclusiveG: Math.floor(targetEnergyKcal * 0.1 / 4 * 10) / 10,
      policy: NUTRITION_POLICY_V1
    }
  };
}

function makeTargets(targetEnergyKcal = 1_920, proteinG = 60) {
  return Array.from({ length: 7 }, (_, index) => (
    makeTarget(index, targetEnergyKcal, proteinG)
  ));
}

function foodsWithTotals(
  prefix: string,
  count: number,
  totals: NutrientValues,
  allergens: readonly string[] = []
): readonly TestFood[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${String(index).padStart(2, '0')}`,
    group: CORE_GROUPS[index % CORE_GROUPS.length] ?? 'grains_tubers',
    nutrients: index === 0 ? totals : ZERO_NUTRIENTS,
    allergens: index === 0 ? allergens : []
  }));
}

function buildFixture(
  definitions: readonly TestMenuDefinition[],
  qualityStatus: 'reviewed' | 'test_fixture' = 'test_fixture'
): TestMealFixture {
  const snapshotsByFood = new Map<string, NutritionDataSnapshot>();
  const recipes: RecipeTemplateVersion[] = [];
  const menus: DailyMenuTemplateVersion[] = [];
  const slots = ['breakfast', 'lunch', 'dinner', 'snack'] as const;

  for (const definition of definitions) {
    for (const food of definition.foods) {
      if (!snapshotsByFood.has(food.id)) {
        snapshotsByFood.set(food.id, {
          id: `snapshot-${food.id}-v1`,
          foodId: food.id,
          canonicalNameZh: `测试${food.id}`,
          foodGroupId: food.group,
          sourceId: 'TEST-SOURCE-V1',
          sourceRecordId: `record-${food.id}`,
          provider: 'test-provider',
          originalUnit: 'per_100_g_edible_portion',
          foodState: 'cooked',
          datasetVersion: 'test-dataset-v1',
          snapshotVersion: 1,
          reviewedAt: '2026-08-10T00:00:00.000Z',
          qualityStatus,
          allergens: food.allergens ?? [],
          nutrientsPer100g: food.nutrients
        });
      }
    }

    const meals = slots.map((slot, slotIndex) => {
      const recipeId = `recipe-${definition.id}-${slot}-v1`;
      recipes.push({
        id: recipeId,
        templateId: `recipe-${definition.id}-${slot}`,
        version: 1,
        dishNameZh: `测试${definition.id}${slot}`,
        sourceId: 'TEST-SOURCE-V1',
        datasetVersion: 'test-dataset-v1',
        reviewedAt: '2026-08-10T00:00:00.000Z',
        qualityStatus,
        ingredients: definition.foods
          .filter((_, foodIndex) => foodIndex % slots.length === slotIndex)
          .map((food) => ({
            foodId: food.id,
            nutritionSnapshotId: `snapshot-${food.id}-v1`,
            grams: definition.grams ?? 100
          }))
      });
      return { slot, recipeTemplateVersionId: recipeId };
    });
    menus.push({
      id: definition.id,
      datasetVersion: 'test-dataset-v1',
      sourceId: 'TEST-SOURCE-V1',
      reviewedAt: '2026-08-10T00:00:00.000Z',
      qualityStatus,
      meals
    });
  }

  return {
    catalog: {
      id: 'catalog-test-v1',
      datasetVersion: 'test-dataset-v1',
      sourceId: 'TEST-SOURCE-V1',
      reviewedAt: '2026-08-10T00:00:00.000Z',
      qualityStatus,
      dailyMenuTemplateVersionIds: definitions.map(({ id }) => id)
    },
    menus,
    recipes,
    snapshots: [...snapshotsByFood.values()]
  };
}

function inventoryFor(
  snapshots: readonly NutritionDataSnapshot[],
  availableGrams = 10_000
): readonly InventoryVersion['items'][number][] {
  return snapshots.map((snapshot) => ({
    foodId: snapshot.foodId,
    nutritionSnapshotId: snapshot.id,
    availableGrams
  }));
}

function generatorInput(
  fixture: TestMealFixture,
  overrides: Partial<Parameters<typeof generateWeeklyMealPlan>[0]> = {}
): Parameters<typeof generateWeeklyMealPlan>[0] {
  return {
    weekStartDate: WEEK_START_DATE,
    targets: makeTargets(),
    inventory: inventoryFor(fixture.snapshots),
    allergens: [],
    avoidFoodIds: [],
    catalog: fixture.catalog,
    menus: fixture.menus,
    recipes: fixture.recipes,
    snapshots: fixture.snapshots,
    allowTestFixtures: true,
    fixedDays: [],
    ...overrides
  };
}

function balancedPoolFixture(): TestMealFixture {
  const foods = Array.from({ length: 28 }, (_, index): TestFood => ({
    id: `pool-${String(index).padStart(2, '0')}`,
    group: CORE_GROUPS[index % CORE_GROUPS.length] ?? 'grains_tubers',
    nutrients: {
      energyKcal: 160,
      proteinG: 5,
      fatG: 4.5,
      carbohydrateG: 24,
      fiberG: 2.2,
      saturatedFatG: 0.4,
      addedSugarG: 0
    }
  }));
  return buildFixture(Array.from({ length: 7 }, (_, menuIndex) => ({
    id: `menu-${String(menuIndex + 1)}`,
    foods: Array.from({ length: 12 }, (_, foodIndex) => (
      foods[(menuIndex * 4 + foodIndex) % foods.length]
    )).filter((food): food is TestFood => food !== undefined)
  })));
}

function singleMenuFixture(
  totals: NutrientValues = BALANCED_TOTALS,
  options: {
    readonly id?: string | undefined;
    readonly grams?: number | undefined;
    readonly allergens?: readonly string[] | undefined;
    readonly foodCount?: number | undefined;
  } = {}
): TestMealFixture {
  const id = options.id ?? 'menu-only';
  return buildFixture([{
    id,
    foods: foodsWithTotals(
      id,
      options.foodCount ?? 25,
      totals,
      options.allergens
    ),
    ...(options.grams === undefined ? {} : { grams: options.grams })
  }]);
}

function expectGenerated(result: ReturnType<typeof generateWeeklyMealPlan>) {
  expect(result).toMatchObject({
    kind: 'generated',
    policyVersion: 'weekly-meal-generation-v1'
  });
  if (result.kind !== 'generated') throw new Error('expected generated weekly meal plan');
  return result;
}

function expectConflict(
  result: ReturnType<typeof generateWeeklyMealPlan>,
  businessDate: string,
  code: string
): void {
  expect(result).toMatchObject({
    kind: 'infeasible',
    code: 'nutrition_constraints_infeasible'
  });
  if (result.kind !== 'infeasible') throw new Error('expected infeasible weekly meal plan');
  expect(result.conflicts).toEqual(expect.arrayContaining([
    expect.objectContaining({ businessDate, code })
  ]));
}

function permutations<T>(values: readonly T[]): readonly (readonly T[])[] {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) => (
    permutations([...values.slice(0, index), ...values.slice(index + 1)])
      .map((rest) => [value, ...rest])
  ));
}

describe('weekly meal policies', () => {
  it('keeps the complete 0.50 through 1.50 serving grid at 0.05 steps', () => {
    expect(WEEKLY_MEAL_SERVING_MULTIPLIERS).toEqual([
      0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95,
      1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.35, 1.4, 1.45, 1.5
    ]);
  });

  it('publishes versioned validation, diversity, and generation provenance', () => {
    expect(MEAL_PLAN_VALIDATION_V1).toEqual({
      policyVersion: 'meal-plan-validation-v1',
      sourceIds: ['CN-DRI-MACRO-2017'],
      energyRelativeTolerance: 0.1,
      proteinRelativeTolerance: 0.1,
      effectiveDate: '2026-08-10',
      reviewedAt: '2026-08-10'
    });
    expect(FOOD_DIVERSITY_POLICY_V1).toEqual({
      policyVersion: 'food-diversity-policy-v1',
      sourceIds: ['CNS-DIETARY-GUIDELINES-2022'],
      minimumDistinctFoodsPerDay: 12,
      minimumCoreFoodGroupsPerDay: 5,
      minimumDistinctFoodsPerWeek: 25,
      effectiveDate: '2026-08-10',
      reviewedAt: '2026-08-10'
    });
    expect(WEEKLY_MEAL_GENERATION_V1).toMatchObject({
      policyVersion: 'weekly-meal-generation-v1',
      sourceIds: ['CNS-DIETARY-GUIDELINES-2022', 'CN-DRI-MACRO-2017'],
      effectiveDate: '2026-08-10',
      reviewedAt: '2026-08-10'
    });
  });
});

describe('generateWeeklyMealPlan', () => {
  it('returns exactly seven complete days for a feasible week', () => {
    const result = expectGenerated(generateWeeklyMealPlan(generatorInput(balancedPoolFixture())));
    expect(result.days).toHaveLength(7);
    expect(result.days.map(({ businessDate }) => businessDate)).toEqual([
      '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20',
      '2026-08-21', '2026-08-22', '2026-08-23'
    ]);
  });

  it('rejects a menu missing a required dinner even when its foods remain complete', () => {
    const fixture = singleMenuFixture(BALANCED_TOTALS, { id: 'menu-missing-dinner' });
    const menu = fixture.menus[0];
    if (menu === undefined) throw new Error('expected menu fixture');
    const dinner = menu.meals.find(({ slot }) => slot === 'dinner');
    const snack = menu.meals.find(({ slot }) => slot === 'snack');
    if (dinner === undefined || snack === undefined) throw new Error('expected dinner and snack');
    const dinnerRecipe = fixture.recipes.find(({ id }) => id === dinner.recipeTemplateVersionId);
    if (dinnerRecipe === undefined) throw new Error('expected dinner recipe');
    const recipes = fixture.recipes.map((recipe) => (
      recipe.id === snack.recipeTemplateVersionId
        ? { ...recipe, ingredients: [...recipe.ingredients, ...dinnerRecipe.ingredients] }
        : recipe
    ));
    const menus = [{
      ...menu,
      meals: menu.meals.filter(({ slot }) => slot !== 'dinner')
    }];

    expectConflict(generateWeeklyMealPlan(generatorInput(fixture, { menus, recipes })),
      '2026-08-17', 'source_chain_incomplete');
  });

  it('rejects a menu that assigns the same meal slot twice', () => {
    const fixture = singleMenuFixture(BALANCED_TOTALS, { id: 'menu-duplicate-slot' });
    const menu = fixture.menus[0];
    if (menu === undefined) throw new Error('expected menu fixture');
    const menus = [{
      ...menu,
      meals: menu.meals.map((meal) => (
        meal.slot === 'dinner' ? { ...meal, slot: 'breakfast' as const } : meal
      ))
    }];

    expectConflict(generateWeeklyMealPlan(generatorInput(fixture, { menus })),
      '2026-08-17', 'source_chain_incomplete');
  });

  it('rounds actual grams first and recomputes every nutrient from per-100-g snapshots', () => {
    const per100g = {
      energyKcal: 1_920 / 0.334,
      proteinG: 60 / 0.334,
      fatG: 55 / 0.334,
      carbohydrateG: 288 / 0.334,
      fiberG: 26 / 0.334,
      saturatedFatG: 5 / 0.334,
      addedSugarG: 0
    };
    const fixture = singleMenuFixture(per100g, { id: 'rounding-menu', grams: 33.35 });
    const result = expectGenerated(generateWeeklyMealPlan(generatorInput(fixture)));
    expect(result.days[0]?.ingredientAmounts).toContainEqual({
      foodId: 'rounding-menu-00',
      grams: 33.4
    });
    expect(result.days[0]?.nutritionTotals).toEqual({
      energyKcal: 1_920,
      proteinG: 60,
      fatG: 55,
      carbohydrateG: 288,
      fiberG: 26,
      saturatedFatG: 5,
      addedSugarG: 0
    });
  });

  it('keeps merged ingredient grams and nutrient totals independently reproducible', () => {
    const fixture = singleMenuFixture({
      ...BALANCED_TOTALS,
      fatG: 55.1,
      fiberG: 26.1
    }, { id: 'menu-duplicate-rounding' });
    const repeatedFoodId = 'menu-duplicate-rounding-00';
    const repeatedSnapshotId = `snapshot-${repeatedFoodId}-v1`;
    const containingRecipeIndex = fixture.recipes.findIndex((recipe) => (
      recipe.ingredients.some(({ foodId }) => foodId === repeatedFoodId)
    ));
    const secondRecipeIndex = fixture.recipes.findIndex((_, index) => (
      index !== containingRecipeIndex
    ));
    const recipes = fixture.recipes.map((recipe, index) => {
      if (index === containingRecipeIndex) {
        return {
          ...recipe,
          ingredients: recipe.ingredients.map((ingredient) => (
            ingredient.foodId === repeatedFoodId
              ? { ...ingredient, grams: 50 }
              : ingredient
          ))
        };
      }
      if (index === secondRecipeIndex) {
        return {
          ...recipe,
          ingredients: [
            ...recipe.ingredients,
            { foodId: repeatedFoodId, nutritionSnapshotId: repeatedSnapshotId, grams: 50 }
          ]
        };
      }
      return recipe;
    });

    const result = expectGenerated(generateWeeklyMealPlan(generatorInput(fixture, { recipes })));
    expect(result.days[0]?.ingredientAmounts).toContainEqual({
      foodId: repeatedFoodId,
      grams: 100
    });
    expect(result.days[0]?.nutritionTotals).toEqual({
      energyKcal: 1_920,
      proteinG: 60,
      fatG: 55.1,
      carbohydrateG: 288,
      fiberG: 26.1,
      saturatedFatG: 5,
      addedSugarG: 0
    });
  });

  it.each([
    ['lower', {
      energyKcal: 1_152,
      proteinG: 36,
      fatG: 32,
      carbohydrateG: 172.8,
      fiberG: 17,
      saturatedFatG: 3,
      addedSugarG: 0
    }, 1.5],
    ['upper', {
      energyKcal: 4_224,
      proteinG: 132,
      fatG: 96,
      carbohydrateG: 576,
      fiberG: 52,
      saturatedFatG: 10,
      addedSugarG: 0
    }, 0.5]
  ])('accepts the exact energy and protein 10%% %s boundaries', (_name, totals, multiplier) => {
    const result = expectGenerated(generateWeeklyMealPlan(
      generatorInput(singleMenuFixture(totals))
    ));
    expect(result.days[0]?.meals.every((meal) => meal.servingMultiplier === multiplier)).toBe(true);
  });

  it.each([
    ['energy', { ...BALANCED_TOTALS, energyKcal: 4_224.2, proteinG: 132 }],
    ['protein', { ...BALANCED_TOTALS, energyKcal: 4_224, proteinG: 132.2 }]
  ])('rejects a candidate just beyond the %s 10%% boundary', (_name, totals) => {
    expectConflict(
      generateWeeklyMealPlan(generatorInput(singleMenuFixture(totals))),
      '2026-08-17',
      'nutrition_out_of_range'
    );
  });

  it.each([
    ['fat lower', { fatG: 40 }],
    ['fat upper', { fatG: 60 }],
    ['carbohydrate lower', { carbohydrateG: 225 }],
    ['carbohydrate upper', { carbohydrateG: 292.5 }],
    ['fiber lower', { fiberG: 25 }],
    ['fiber upper', { fiberG: 30 }]
  ])('accepts the inclusive %s macro or fiber boundary', (_name, override) => {
    const totals = {
      ...BALANCED_TOTALS,
      energyKcal: 1_800,
      fatG: 50,
      carbohydrateG: 270,
      fiberG: 27,
      ...override
    };
    expectGenerated(generateWeeklyMealPlan(generatorInput(
      singleMenuFixture(totals),
      { targets: makeTargets(1_800, 60) }
    )));
  });

  it.each([
    ['fat below 20%E', { fatG: 39.9 }],
    ['fat above 30%E', { fatG: 60.1 }],
    ['carbohydrate below 50%E', { carbohydrateG: 224.9 }],
    ['carbohydrate above 65%E', { carbohydrateG: 292.6 }]
  ])('rejects the strict %s limit', (_name, override) => {
    const totals = {
      ...BALANCED_TOTALS,
      energyKcal: 1_800,
      fatG: 50,
      carbohydrateG: 270,
      fiberG: 27,
      ...override
    };
    expectConflict(generateWeeklyMealPlan(generatorInput(
      singleMenuFixture(totals),
      { targets: makeTargets(1_800, 60) }
    )), '2026-08-17', 'nutrition_out_of_range');
  });

  it.each([
    ['120 g carbohydrate minimum', {
      energyKcal: 880,
      proteinG: 60,
      fatG: 24.4,
      carbohydrateG: 119.9,
      fiberG: 25,
      saturatedFatG: 2,
      addedSugarG: 0
    }, 800],
    ['25 g fiber minimum', {
      energyKcal: 1_980,
      proteinG: 60,
      fatG: 55,
      carbohydrateG: 297,
      fiberG: 24.9,
      saturatedFatG: 5,
      addedSugarG: 0
    }, 1_800],
    ['30 g fiber maximum', {
      energyKcal: 1_620,
      proteinG: 60,
      fatG: 45,
      carbohydrateG: 243,
      fiberG: 30.1,
      saturatedFatG: 5,
      addedSugarG: 0
    }, 1_800],
    ['saturated fat maximum exclusive', {
      energyKcal: 1_800,
      proteinG: 60,
      fatG: 50,
      carbohydrateG: 270,
      fiberG: 27,
      saturatedFatG: 20,
      addedSugarG: 0
    }, 1_800],
    ['added sugar maximum exclusive', {
      energyKcal: 1_800,
      proteinG: 60,
      fatG: 50,
      carbohydrateG: 270,
      fiberG: 27,
      saturatedFatG: 5,
      addedSugarG: 45
    }, 1_800]
  ])('rejects a candidate violating the strict %s', (_name, totals, targetEnergy) => {
    expectConflict(generateWeeklyMealPlan(generatorInput(
      singleMenuFixture(totals),
      { targets: makeTargets(targetEnergy, 60) }
    )), '2026-08-17', 'nutrition_out_of_range');
  });

  it('requires 12 distinct foods on every day', () => {
    const elevenFoods = singleMenuFixture(BALANCED_TOTALS, { foodCount: 11 });
    expectConflict(
      generateWeeklyMealPlan(generatorInput(elevenFoods)),
      '2026-08-17',
      'food_diversity_insufficient'
    );
  });

  it('requires five core food groups on every day', () => {
    const fourGroups = singleMenuFixture(BALANCED_TOTALS);
    const restrictedSnapshots = fourGroups.snapshots.map((snapshot, index) => ({
      ...snapshot,
      foodGroupId: CORE_GROUPS[index % 4] ?? 'grains_tubers'
    }));
    expectConflict(generateWeeklyMealPlan(generatorInput(fourGroups, {
      snapshots: restrictedSnapshots,
      inventory: inventoryFor(restrictedSnapshots)
    })), '2026-08-17', 'food_diversity_insufficient');
  });

  it('rejects a candidate containing an ingredient that rounds to zero grams', () => {
    const foods = [
      ...foodsWithTotals('positive-amount', 25, {
        energyKcal: 2_112,
        proteinG: 66,
        fatG: 58.7,
        carbohydrateG: 316.8,
        fiberG: 25,
        saturatedFatG: 5,
        addedSugarG: 0
      }),
      {
        id: 'rounds-to-zero',
        group: 'dairy' as const,
        nutrients: ZERO_NUTRIENTS
      }
    ];
    const fixture = buildFixture([{ id: 'menu-zero-grams', foods }]);
    const recipes = fixture.recipes.map((recipe) => ({
      ...recipe,
      ingredients: recipe.ingredients.map((ingredient) => (
        ingredient.foodId === 'rounds-to-zero'
          ? { ...ingredient, grams: 0.04 }
          : ingredient
      ))
    }));

    expectConflict(generateWeeklyMealPlan(generatorInput(fixture, { recipes })),
      '2026-08-17', 'food_diversity_insufficient');
  });

  it('requires 25 distinct foods across the completed week', () => {
    const fixture = singleMenuFixture(BALANCED_TOTALS, { foodCount: 12 });
    expectConflict(
      generateWeeklyMealPlan(generatorInput(fixture)),
      '2026-08-23',
      'food_diversity_insufficient'
    );
  });

  it('enforces inventory cumulatively across all seven days', () => {
    const fixture = singleMenuFixture();
    expectConflict(generateWeeklyMealPlan(generatorInput(fixture, {
      inventory: inventoryFor(fixture.snapshots, 629.9)
    })), '2026-08-23', 'inventory_insufficient');
  });

  it('rejects inventory that is fractionally below the exact weekly usage', () => {
    const fixture = singleMenuFixture({
      energyKcal: 2_112,
      proteinG: 66,
      fatG: 58.7,
      carbohydrateG: 316.8,
      fiberG: 25,
      saturatedFatG: 5,
      addedSugarG: 0
    }, { id: 'menu-fractional-shortage' });

    expectConflict(generateWeeklyMealPlan(generatorInput(fixture, {
      inventory: inventoryFor(fixture.snapshots, 699.95)
    })), '2026-08-23', 'inventory_insufficient');
  });

  it('accepts decimal inventory exactly equal to the weekly usage', () => {
    const fixture = singleMenuFixture({
      energyKcal: 2_112,
      proteinG: 66,
      fatG: 58.7,
      carbohydrateG: 316.8,
      fiberG: 25,
      saturatedFatG: 5,
      addedSugarG: 0
    }, { id: 'menu-fractional-exact' });

    expectGenerated(generateWeeklyMealPlan(generatorInput(fixture, {
      inventory: inventoryFor(fixture.snapshots, 700)
    })));
  });

  it('never selects a declared allergen for every allergen subset and candidate permutation', () => {
    const definitions = [
      { id: 'menu-safe', foods: foodsWithTotals('safe', 25, BALANCED_TOTALS) },
      { id: 'menu-soy', foods: foodsWithTotals('soy', 25, BALANCED_TOTALS, ['大豆']) },
      { id: 'menu-fish', foods: foodsWithTotals('fish', 25, BALANCED_TOTALS, ['鱼类']) }
    ] as const;
    const fixture = buildFixture(definitions);
    const allergenSubsets = [[], ['大豆'], ['鱼类'], ['大豆', '鱼类']] as const;

    for (const allergenSubset of allergenSubsets) {
      for (const menuOrder of permutations(fixture.menus)) {
        const catalog = {
          ...fixture.catalog,
          dailyMenuTemplateVersionIds: menuOrder.map(({ id }) => id)
        };
        const result = expectGenerated(generateWeeklyMealPlan(generatorInput(fixture, {
          allergens: allergenSubset,
          catalog,
          menus: menuOrder
        })));
        const snapshots = new Map(fixture.snapshots.map((snapshot) => [snapshot.foodId, snapshot]));
        const declaredAllergens = new Set<string>(allergenSubset);
        for (const day of result.days) {
          for (const ingredient of day.ingredientAmounts) {
            const snapshot = snapshots.get(ingredient.foodId);
            expect(snapshot?.allergens.some((allergen) => declaredAllergens.has(allergen))).toBe(false);
          }
        }
      }
    }
  });

  it('returns a dated allergen conflict when no safe candidate exists', () => {
    const fixture = singleMenuFixture(BALANCED_TOTALS, { allergens: ['大豆'] });
    expectConflict(generateWeeklyMealPlan(generatorInput(fixture, {
      allergens: ['  大 豆  ']
    })), '2026-08-17', 'allergen_detected');
  });

  it('returns a dated avoided-food conflict when every candidate contains an avoided food', () => {
    const fixture = singleMenuFixture();
    expectConflict(generateWeeklyMealPlan(generatorInput(fixture, {
      avoidFoodIds: ['menu-only-00']
    })), '2026-08-17', 'avoided_food');
  });

  it.each([
    ['missing', (snapshots: readonly NutritionDataSnapshot[]) => snapshots.slice(1)],
    ['mismatched', (snapshots: readonly NutritionDataSnapshot[]) => {
      const first = snapshots[0];
      if (first === undefined) throw new Error('expected source fixture');
      return [{ ...first, foodId: 'different-food' }, ...snapshots.slice(1)];
    }]
  ])('returns a dated source conflict for a %s nutrition snapshot', (_name, mutate) => {
    const fixture = singleMenuFixture();
    const snapshots = mutate(fixture.snapshots);
    expectConflict(generateWeeklyMealPlan(generatorInput(fixture, {
      snapshots,
      inventory: inventoryFor(snapshots)
    })), '2026-08-17', 'source_chain_incomplete');
  });

  it('rejects an unreviewed source outside fixture mode', () => {
    const reviewed = buildFixture([{
      id: 'menu-reviewed',
      foods: foodsWithTotals('reviewed', 25, BALANCED_TOTALS)
    }], 'reviewed');
    const firstSnapshot = reviewed.snapshots[0];
    if (firstSnapshot === undefined) throw new Error('expected reviewed source fixture');
    const snapshots = [
      { ...firstSnapshot, qualityStatus: 'test_fixture' as const },
      ...reviewed.snapshots.slice(1)
    ];
    expectConflict(generateWeeklyMealPlan(generatorInput(reviewed, {
      snapshots,
      inventory: inventoryFor(snapshots),
      allowTestFixtures: false
    })), '2026-08-17', 'source_chain_incomplete');
  });

  it('returns a dated target conflict for an unsupported target', () => {
    const fixture = singleMenuFixture();
    const targets = makeTargets();
    const target = targets[3];
    if (target === undefined) throw new Error('expected fourth target fixture');
    const unsupported: DailyNutritionTargetVersion = {
      ...target,
      nutrition: null,
      energy: {
        kind: 'unsupported',
        code: 'unsupported_for_personalized_energy',
        reasons: ['bmi_out_of_range'],
        bmi: 24,
        policy: {
          policyVersion: 'calculation-policy-v2',
          sourceIds: ['CN-BMR-2023'],
          applicableAgeRange: { minInclusive: 18, maxInclusive: 45 },
          applicableBmiRange: { minInclusive: 18.5, maxExclusive: 24 },
          rounding: { kcal: 'nearest_whole_half_up', bmi: 'nearest_hundredth_half_up' }
        }
      }
    };
    targets[3] = unsupported;
    expectConflict(generateWeeklyMealPlan(generatorInput(fixture, { targets })),
      '2026-08-20', 'target_nutrition_infeasible');
  });

  it('returns the missing date when the seven-day target input is incomplete', () => {
    const fixture = singleMenuFixture();
    expectConflict(generateWeeklyMealPlan(generatorInput(fixture, {
      targets: makeTargets().filter(({ businessDate }) => businessDate !== '2026-08-20')
    })), '2026-08-20', 'target_nutrition_infeasible');
  });

  it('uses stable menu tie-breaking and returns deep-equal results for permuted inputs', () => {
    const foods = foodsWithTotals('tie', 25, BALANCED_TOTALS);
    const fixture = buildFixture([
      { id: 'menu-z', foods },
      { id: 'menu-a', foods }
    ]);
    const first = generateWeeklyMealPlan(generatorInput(fixture));
    const second = generateWeeklyMealPlan(generatorInput(fixture, {
      catalog: {
        ...fixture.catalog,
        dailyMenuTemplateVersionIds: [...fixture.catalog.dailyMenuTemplateVersionIds].reverse()
      },
      menus: [...fixture.menus].reverse(),
      recipes: [...fixture.recipes].reverse(),
      snapshots: [...fixture.snapshots].reverse()
    }));
    const generated = expectGenerated(first);
    expect(generated.days.every((day) => day.dailyMenuTemplateVersionId === 'menu-a')).toBe(true);
    expect(second).toEqual(first);
    expect(generateWeeklyMealPlan(generatorInput(fixture))).toEqual(first);
  });

  it('backtracks from the preferred first-day menu to find a complete inventory-feasible week', () => {
    const menuAFoods = foodsWithTotals('backtrack-a', 25, {
      energyKcal: 1_000,
      proteinG: 50,
      fatG: 27.8,
      carbohydrateG: 150,
      fiberG: 28,
      saturatedFatG: 3,
      addedSugarG: 0
    });
    const menuBFoods = foodsWithTotals('backtrack-b', 25, {
      energyKcal: 2_000,
      proteinG: 100,
      fatG: 55.6,
      carbohydrateG: 300,
      fiberG: 52,
      saturatedFatG: 6,
      addedSugarG: 0
    });
    const fixture = buildFixture([
      { id: 'menu-a-preferred', foods: menuAFoods },
      { id: 'menu-b-fallback', foods: menuBFoods }
    ]);
    const targets = [makeTarget(0, 1_000, 50), ...Array.from(
      { length: 6 },
      (_, index) => makeTarget(index + 1, 900, 45)
    )];
    const inventory = fixture.snapshots.map((snapshot) => ({
      foodId: snapshot.foodId,
      nutritionSnapshotId: snapshot.id,
      availableGrams: snapshot.foodId.startsWith('backtrack-a') ? 540 : 100
    }));

    const result = expectGenerated(generateWeeklyMealPlan(generatorInput(fixture, {
      targets,
      inventory
    })));
    expect(result.days[0]?.dailyMenuTemplateVersionId).toBe('menu-b-fallback');
    expect(result.days.slice(1).every((day) => (
      day.dailyMenuTemplateVersionId === 'menu-a-preferred'
    ))).toBe(true);
  });

  it('charges fixed days against inventory before regenerating another date', () => {
    const fixture = singleMenuFixture();
    const initial = expectGenerated(generateWeeklyMealPlan(generatorInput(fixture)));
    expectConflict(generateWeeklyMealPlan(generatorInput(fixture, {
      inventory: inventoryFor(fixture.snapshots, 699.9),
      fixedDays: initial.days.filter(({ businessDate }) => businessDate !== '2026-08-20')
    })), '2026-08-20', 'inventory_insufficient');
  });

  it('keeps fixed days byte-equivalent and regenerates only omitted dates', () => {
    const fixture = singleMenuFixture();
    const initial = expectGenerated(generateWeeklyMealPlan(generatorInput(fixture)));
    const targets = makeTargets();
    targets[3] = makeTarget(3, 2_112, 66);
    const fixedDays = initial.days.filter(({ businessDate }) => businessDate !== '2026-08-20');
    const regenerated = expectGenerated(generateWeeklyMealPlan(generatorInput(fixture, {
      targets,
      fixedDays
    })));

    for (const fixedDay of fixedDays) {
      expect(regenerated.days.find(({ businessDate }) => (
        businessDate === fixedDay.businessDate
      ))).toStrictEqual(fixedDay);
    }
    const changed = regenerated.days.find(({ businessDate }) => businessDate === '2026-08-20');
    expect(changed?.dailyNutritionTargetVersionId).toBe('nutrition-target-2026-08-20');
    expect(changed?.meals.some(({ servingMultiplier }) => servingMultiplier === 1.1)).toBe(true);
  });

  it('rejects a fixed day that contains a newly declared allergen', () => {
    const fixture = singleMenuFixture();
    const initial = expectGenerated(generateWeeklyMealPlan(generatorInput(fixture)));
    const firstSnapshot = fixture.snapshots[0];
    if (firstSnapshot === undefined) throw new Error('expected fixed-day snapshot fixture');
    const snapshots = [
      { ...firstSnapshot, allergens: ['大豆'] },
      ...fixture.snapshots.slice(1)
    ];

    expectConflict(generateWeeklyMealPlan(generatorInput(fixture, {
      allergens: ['大豆'],
      snapshots,
      fixedDays: initial.days
    })), '2026-08-17', 'allergen_detected');
  });

  it('rejects a fixed day that contains a newly avoided food', () => {
    const fixture = singleMenuFixture();
    const initial = expectGenerated(generateWeeklyMealPlan(generatorInput(fixture)));

    expectConflict(generateWeeklyMealPlan(generatorInput(fixture, {
      avoidFoodIds: ['menu-only-00'],
      fixedDays: initial.days
    })), '2026-08-17', 'avoided_food');
  });

  it('rejects a fixed day whose inventory snapshot identity no longer matches', () => {
    const fixture = singleMenuFixture();
    const initial = expectGenerated(generateWeeklyMealPlan(generatorInput(fixture)));
    const firstInventoryItem = inventoryFor(fixture.snapshots)[0];
    if (firstInventoryItem === undefined) throw new Error('expected fixed-day inventory fixture');
    const inventory = [
      { ...firstInventoryItem, nutritionSnapshotId: 'snapshot-different-v1' },
      ...inventoryFor(fixture.snapshots).slice(1)
    ];

    expectConflict(generateWeeklyMealPlan(generatorInput(fixture, {
      inventory,
      fixedDays: initial.days
    })), '2026-08-17', 'source_chain_incomplete');
  });

  it('returns a dated inventory conflict when a fixed-day food is unavailable', () => {
    const fixture = singleMenuFixture();
    const initial = expectGenerated(generateWeeklyMealPlan(generatorInput(fixture)));

    expectConflict(generateWeeklyMealPlan(generatorInput(fixture, {
      inventory: inventoryFor(fixture.snapshots).filter(({ foodId }) => (
        foodId !== 'menu-only-00'
      )),
      fixedDays: initial.days
    })), '2026-08-17', 'inventory_insufficient');
  });

  it('rejects an unreviewed fixed-day source outside fixture mode', () => {
    const reviewed = buildFixture([{
      id: 'menu-fixed-reviewed',
      foods: foodsWithTotals('fixed-reviewed', 25, BALANCED_TOTALS)
    }], 'reviewed');
    const initial = expectGenerated(generateWeeklyMealPlan(generatorInput(reviewed, {
      allowTestFixtures: false
    })));
    const firstSnapshot = reviewed.snapshots[0];
    if (firstSnapshot === undefined) throw new Error('expected reviewed fixed-day fixture');
    const snapshots = [
      { ...firstSnapshot, qualityStatus: 'test_fixture' as const },
      ...reviewed.snapshots.slice(1)
    ];

    expectConflict(generateWeeklyMealPlan(generatorInput(reviewed, {
      allowTestFixtures: false,
      snapshots,
      fixedDays: initial.days
    })), '2026-08-17', 'source_chain_incomplete');
  });

  it('rejects a fixed day that references a menu with duplicate meal slots', () => {
    const fixture = singleMenuFixture();
    const initial = expectGenerated(generateWeeklyMealPlan(generatorInput(fixture)));
    const menu = fixture.menus[0];
    if (menu === undefined) throw new Error('expected fixed menu fixture');
    const menus = [{
      ...menu,
      meals: menu.meals.map((meal) => (
        meal.slot === 'dinner' ? { ...meal, slot: 'breakfast' as const } : meal
      ))
    }];

    expectConflict(generateWeeklyMealPlan(generatorInput(fixture, {
      menus,
      fixedDays: initial.days
    })), '2026-08-17', 'source_chain_incomplete');
  });

  it('rebuilds fixed-day recipes and rejects an omitted allergen ingredient', () => {
    const fixture = singleMenuFixture(BALANCED_TOTALS, {
      id: 'menu-fixed-omitted-allergen',
      foodCount: 26,
      allergens: ['大豆']
    });
    const initial = expectGenerated(generateWeeklyMealPlan(generatorInput(fixture)));
    const omittedFoodId = 'menu-fixed-omitted-allergen-00';
    const omittedSnapshotId = `snapshot-${omittedFoodId}-v1`;
    const fixedDays = initial.days.map((day) => ({
      ...day,
      ingredientAmounts: day.ingredientAmounts.filter(({ foodId }) => (
        foodId !== omittedFoodId
      )),
      nutritionSourceSnapshotIds: day.nutritionSourceSnapshotIds.filter((snapshotId) => (
        snapshotId !== omittedSnapshotId
      ))
    }));

    expectConflict(generateWeeklyMealPlan(generatorInput(fixture, {
      allergens: ['大豆'],
      fixedDays
    })), '2026-08-17', 'allergen_detected');
  });

  it('rejects fixed-day meals from menu B when the day declares menu A', () => {
    const foods = foodsWithTotals('fixed-menu-source', 25, BALANCED_TOTALS);
    const fixture = buildFixture([
      { id: 'menu-fixed-a', foods },
      { id: 'menu-fixed-b', foods }
    ]);
    const initial = expectGenerated(generateWeeklyMealPlan(generatorInput(fixture)));
    const menuB = fixture.menus.find(({ id }) => id === 'menu-fixed-b');
    if (menuB === undefined) throw new Error('expected menu B fixture');
    const recipeBySlot = new Map(menuB.meals.map((meal) => [meal.slot, meal.recipeTemplateVersionId]));
    const fixedDays = initial.days.map((day) => ({
      ...day,
      meals: day.meals.map((meal) => ({
        ...meal,
        recipeTemplateVersionId: recipeBySlot.get(meal.slot) ?? meal.recipeTemplateVersionId
      }))
    }));

    expectConflict(generateWeeklyMealPlan(generatorInput(fixture, { fixedDays })),
      '2026-08-17', 'source_chain_incomplete');
  });

  it('rejects a fixed day whose persisted snapshot differs from its recipe snapshot', () => {
    const fixture = singleMenuFixture();
    const initial = expectGenerated(generateWeeklyMealPlan(generatorInput(fixture)));
    const originalSnapshot = fixture.snapshots[0];
    if (originalSnapshot === undefined) throw new Error('expected original snapshot fixture');
    const alternateSnapshot = {
      ...originalSnapshot,
      id: 'snapshot-menu-only-00-alternate-v2',
      snapshotVersion: 2
    };
    const inventory = inventoryFor(fixture.snapshots).map((item) => (
      item.foodId === originalSnapshot.foodId
        ? { ...item, nutritionSnapshotId: alternateSnapshot.id }
        : item
    ));
    const fixedDays = initial.days.map((day) => ({
      ...day,
      nutritionSourceSnapshotIds: day.nutritionSourceSnapshotIds.map((snapshotId) => (
        snapshotId === originalSnapshot.id ? alternateSnapshot.id : snapshotId
      ))
    }));

    expectConflict(generateWeeklyMealPlan(generatorInput(fixture, {
      snapshots: [alternateSnapshot, ...fixture.snapshots],
      inventory,
      fixedDays
    })), '2026-08-17', 'source_chain_incomplete');
  });

  it('rejects a fixed day whose persisted nutrition total was altered', () => {
    const fixture = singleMenuFixture();
    const initial = expectGenerated(generateWeeklyMealPlan(generatorInput(fixture)));
    const fixedDays = initial.days.map((day) => ({
      ...day,
      nutritionTotals: {
        ...day.nutritionTotals,
        energyKcal: day.nutritionTotals.energyKcal + 0.1
      }
    }));

    expectConflict(generateWeeklyMealPlan(generatorInput(fixture, { fixedDays })),
      '2026-08-17', 'source_chain_incomplete');
  });

  it('reuses a valid fixed-day object by reference after rebuilding it', () => {
    const fixture = singleMenuFixture();
    const initial = expectGenerated(generateWeeklyMealPlan(generatorInput(fixture)));
    const reused = expectGenerated(generateWeeklyMealPlan(generatorInput(fixture, {
      fixedDays: initial.days
    })));

    expect(reused.days[0]).toBe(initial.days[0]);
  });

  it('rejects duplicate fixed dates instead of silently collapsing them', () => {
    const fixture = singleMenuFixture();
    const initial = expectGenerated(generateWeeklyMealPlan(generatorInput(fixture)));
    const firstDay = initial.days[0];
    if (firstDay === undefined) throw new Error('expected first fixed day');

    expectConflict(generateWeeklyMealPlan(generatorInput(fixture, {
      fixedDays: [...initial.days, firstDay]
    })), '2026-08-17', 'source_chain_incomplete');
  });

  it('rejects a fixed date outside the requested week', () => {
    const fixture = singleMenuFixture();
    const initial = expectGenerated(generateWeeklyMealPlan(generatorInput(fixture)));
    const firstDay = initial.days[0];
    if (firstDay === undefined) throw new Error('expected first fixed day');

    expectConflict(generateWeeklyMealPlan(generatorInput(fixture, {
      fixedDays: [
        ...initial.days,
        { ...firstDay, businessDate: '2026-08-24' }
      ]
    })), '2026-08-24', 'source_chain_incomplete');
  });
});
