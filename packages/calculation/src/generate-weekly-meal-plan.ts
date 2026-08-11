import type {
  DailyMenuCatalogVersion,
  DailyMenuTemplateVersion,
  DailyNutritionTargetVersion,
  InventoryVersion,
  MealPlanDay,
  MealSlot,
  NutrientValues,
  NutritionDataSnapshot,
  NutritionTargetResult,
  RecipeCandidateConflict,
  RecipeTemplateVersion
} from '@fitness/domain';
import { canonicalizeAllergenTerm } from '@fitness/domain';
import { evaluateRecipeCandidate } from './evaluate-recipe-candidate';
import {
  FOOD_DIVERSITY_POLICY_V1,
  MEAL_PLAN_VALIDATION_V1,
  WEEKLY_MEAL_GENERATION_V1,
  WEEKLY_MEAL_SERVING_MULTIPLIERS
} from './meal-plan-policy';
import { roundHalfUp } from './rounding';

export type WeeklyMealConflictCode =
  | 'target_nutrition_infeasible'
  | 'source_chain_incomplete'
  | 'allergen_detected'
  | 'avoided_food'
  | 'inventory_insufficient'
  | 'nutrition_out_of_range'
  | 'food_diversity_insufficient';

export interface WeeklyMealConflict {
  readonly businessDate: string;
  readonly code: WeeklyMealConflictCode;
  readonly foodId?: string | undefined;
  readonly requiredGrams?: number | undefined;
  readonly availableGrams?: number | undefined;
}

export type WeeklyMealInfeasibleResult = {
  readonly kind: 'infeasible';
  readonly code: 'nutrition_constraints_infeasible';
  readonly conflicts: readonly WeeklyMealConflict[];
};

export type WeeklyMealGenerationResult =
  | {
      readonly kind: 'generated';
      readonly policyVersion: 'weekly-meal-generation-v1';
      readonly catalogVersionId: string;
      readonly days: readonly MealPlanDay[];
    }
  | WeeklyMealInfeasibleResult;

export interface WeeklyMealGenerationInput {
  readonly weekStartDate: string;
  readonly targets: readonly DailyNutritionTargetVersion[];
  readonly inventory: readonly InventoryVersion['items'][number][];
  readonly allergens: readonly string[];
  readonly avoidFoodIds: readonly string[];
  readonly catalog: DailyMenuCatalogVersion;
  readonly menus: readonly DailyMenuTemplateVersion[];
  readonly recipes: readonly RecipeTemplateVersion[];
  readonly snapshots: readonly NutritionDataSnapshot[];
  readonly allowTestFixtures: boolean;
  readonly fixedDays: readonly MealPlanDay[];
}

interface ExpandedCandidate {
  readonly day: MealPlanDay;
  readonly energyDeviation: number;
  readonly proteinDeviation: number;
  readonly foodIds: ReadonlySet<string>;
}

type CandidateExpansion =
  | { readonly kind: 'accepted'; readonly candidate: ExpandedCandidate }
  | { readonly kind: 'rejected'; readonly conflicts: readonly WeeklyMealConflict[] };

interface ConsumptionFailure {
  readonly foodId: string;
  readonly requiredGrams: number;
  readonly availableGrams: number;
}

interface InventoryBalance {
  readonly availableGrams: number;
  readonly consumedDecigrams: number;
}

const MEAL_SLOT_ORDER: Readonly<Record<MealSlot, number>> = {
  breakfast: 0,
  lunch: 1,
  dinner: 2,
  snack: 3
};
const CORE_FOOD_GROUPS = new Set([
  'grains_tubers',
  'vegetables',
  'fruit',
  'animal_protein',
  'soy_nuts',
  'dairy'
]);
const CONFLICT_ORDER: Readonly<Record<WeeklyMealConflictCode, number>> = {
  target_nutrition_infeasible: 0,
  source_chain_incomplete: 1,
  allergen_detected: 2,
  avoided_food: 3,
  inventory_insufficient: 4,
  nutrition_out_of_range: 5,
  food_diversity_insufficient: 6
};

function addBusinessDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function infeasible(conflicts: readonly WeeklyMealConflict[]): WeeklyMealInfeasibleResult {
  const unique = new Map<string, WeeklyMealConflict>();
  for (const conflict of conflicts) {
    const key = [
      conflict.businessDate,
      conflict.code,
      conflict.foodId ?? '',
      conflict.requiredGrams ?? '',
      conflict.availableGrams ?? ''
    ].join('|');
    if (!unique.has(key)) unique.set(key, conflict);
  }
  return {
    kind: 'infeasible',
    code: 'nutrition_constraints_infeasible',
    conflicts: [...unique.values()].sort((left, right) => (
      left.businessDate.localeCompare(right.businessDate)
      || CONFLICT_ORDER[left.code] - CONFLICT_ORDER[right.code]
      || (left.foodId ?? '').localeCompare(right.foodId ?? '')
      || (left.requiredGrams ?? 0) - (right.requiredGrams ?? 0)
      || (left.availableGrams ?? 0) - (right.availableGrams ?? 0)
    ))
  };
}

function relativeDeviation(actual: number, target: number): number {
  return Math.abs(actual - target) / target;
}

function withinInclusive(value: number, minimum: number, maximum: number): boolean {
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(minimum), Math.abs(maximum)) * 8;
  return value >= minimum - tolerance && value <= maximum + tolerance;
}

function belowExclusive(value: number, maximum: number): boolean {
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(maximum)) * 8;
  return value < maximum - tolerance;
}

function nutritionWithinRange(
  totals: NutrientValues,
  target: Extract<NutritionTargetResult, { readonly kind: 'feasible' }>
): boolean {
  if (totals.energyKcal <= 0 || target.targetEnergyKcal <= 0 || target.proteinG <= 0) return false;
  if (!withinInclusive(
    relativeDeviation(totals.energyKcal, target.targetEnergyKcal),
    0,
    MEAL_PLAN_VALIDATION_V1.energyRelativeTolerance
  )) return false;
  if (!withinInclusive(
    relativeDeviation(totals.proteinG, target.proteinG),
    0,
    MEAL_PLAN_VALIDATION_V1.proteinRelativeTolerance
  )) return false;

  const policy = target.policy;
  const fatShare = totals.fatG * policy.kcalPerGram.fat / totals.energyKcal;
  const carbohydrateShare = (
    totals.carbohydrateG * policy.kcalPerGram.carbohydrate / totals.energyKcal
  );
  const saturatedFatShare = (
    totals.saturatedFatG * policy.kcalPerGram.fat / totals.energyKcal
  );
  const addedSugarShare = (
    totals.addedSugarG * policy.kcalPerGram.carbohydrate / totals.energyKcal
  );

  return withinInclusive(
    fatShare,
    policy.fatEnergyRange.minInclusive,
    policy.fatEnergyRange.maxInclusive
  ) && withinInclusive(
    carbohydrateShare,
    policy.carbohydrateEnergyRange.minInclusive,
    policy.carbohydrateEnergyRange.maxInclusive
  ) && totals.carbohydrateG >= policy.carbohydrateMinimumG
    && withinInclusive(
      totals.fiberG,
      policy.fiberRangeG.minInclusive,
      policy.fiberRangeG.maxInclusive
    )
    && belowExclusive(saturatedFatShare, policy.saturatedFatEnergyMaxExclusive)
    && belowExclusive(addedSugarShare, policy.addedSugarEnergyMaxExclusive);
}

function qualityAllowed(
  value: { readonly qualityStatus: 'reviewed' | 'test_fixture' },
  allowTestFixtures: boolean
): boolean {
  return value.qualityStatus === 'reviewed' || allowTestFixtures;
}

function hasRequiredUniqueMealSlots(
  meals: readonly { readonly slot: MealSlot }[]
): boolean {
  const counts = new Map<MealSlot, number>();
  for (const meal of meals) counts.set(meal.slot, (counts.get(meal.slot) ?? 0) + 1);
  return counts.get('breakfast') === 1
    && counts.get('lunch') === 1
    && counts.get('dinner') === 1
    && (counts.get('snack') ?? 0) <= 1
    && counts.size === meals.length;
}

function mapRecipeConflict(
  businessDate: string,
  conflict: RecipeCandidateConflict
): WeeklyMealConflict {
  switch (conflict.code) {
    case 'allergen_detected':
      return { businessDate, code: 'allergen_detected', foodId: conflict.foodId };
    case 'avoided_food':
      return { businessDate, code: 'avoided_food', foodId: conflict.foodId };
    case 'inventory_insufficient':
      return {
        businessDate,
        code: 'inventory_insufficient',
        foodId: conflict.foodId,
        requiredGrams: conflict.requiredGrams,
        availableGrams: conflict.availableGrams
      };
    case 'food_diversity_insufficient':
      return { businessDate, code: 'food_diversity_insufficient' };
    default:
      return {
        businessDate,
        code: 'source_chain_incomplete',
        ...('foodId' in conflict ? { foodId: conflict.foodId } : {})
      };
  }
}

function expandCandidate(input: {
  readonly businessDate: string;
  readonly target: DailyNutritionTargetVersion;
  readonly menu: DailyMenuTemplateVersion;
  readonly multiplier: number;
  readonly recipesById: ReadonlyMap<string, RecipeTemplateVersion>;
  readonly snapshots: readonly NutritionDataSnapshot[];
  readonly snapshotsById: ReadonlyMap<string, NutritionDataSnapshot>;
  readonly inventory: readonly InventoryVersion['items'][number][];
  readonly inventoryByFoodId: ReadonlyMap<string, InventoryVersion['items'][number]>;
  readonly allergens: readonly string[];
  readonly avoidFoodIds: readonly string[];
  readonly allowTestFixtures: boolean;
}): CandidateExpansion {
  const sourceConflict = (foodId?: string): CandidateExpansion => ({
    kind: 'rejected',
    conflicts: [{
      businessDate: input.businessDate,
      code: 'source_chain_incomplete',
      ...(foodId === undefined ? {} : { foodId })
    }]
  });
  if (!qualityAllowed(input.menu, input.allowTestFixtures)) return sourceConflict();
  if (!hasRequiredUniqueMealSlots(input.menu.meals)) return sourceConflict();

  const orderedMeals = [...input.menu.meals].sort((left, right) => (
    MEAL_SLOT_ORDER[left.slot] - MEAL_SLOT_ORDER[right.slot]
    || left.recipeTemplateVersionId.localeCompare(right.recipeTemplateVersionId)
  ));
  const ingredients: {
    foodId: string;
    nutritionSnapshotId: string;
    grams: number;
  }[] = [];
  for (const meal of orderedMeals) {
    const recipe = input.recipesById.get(meal.recipeTemplateVersionId);
    if (recipe === undefined || !qualityAllowed(recipe, input.allowTestFixtures)) {
      return sourceConflict();
    }
    for (const ingredient of recipe.ingredients) {
      const inventoryItem = input.inventoryByFoodId.get(ingredient.foodId);
      if (
        inventoryItem !== undefined
        && inventoryItem.nutritionSnapshotId !== ingredient.nutritionSnapshotId
      ) return sourceConflict(ingredient.foodId);
      const actualGrams = roundHalfUp(ingredient.grams * input.multiplier, 1);
      if (actualGrams < 0.1) {
        return {
          kind: 'rejected',
          conflicts: [{
            businessDate: input.businessDate,
            code: 'food_diversity_insufficient',
            foodId: ingredient.foodId
          }]
        };
      }
      ingredients.push({
        foodId: ingredient.foodId,
        nutritionSnapshotId: ingredient.nutritionSnapshotId,
        grams: actualGrams
      });
    }
  }

  const evaluation = evaluateRecipeCandidate({
    template: {
      id: `expanded-${input.menu.id}-${String(input.multiplier)}`,
      templateId: input.menu.id,
      version: 1,
      dishNameZh: input.menu.id,
      sourceId: input.menu.sourceId,
      datasetVersion: input.menu.datasetVersion,
      reviewedAt: input.menu.reviewedAt,
      qualityStatus: input.menu.qualityStatus,
      ingredients
    },
    snapshots: input.snapshots,
    inventory: input.inventory,
    allergens: input.allergens,
    avoidFoodIds: input.avoidFoodIds,
    minimumDistinctFoodGroups: 0,
    allowTestFixtures: input.allowTestFixtures
  });
  if (evaluation.kind === 'infeasible') {
    return {
      kind: 'rejected',
      conflicts: evaluation.conflicts.map((conflict) => (
        mapRecipeConflict(input.businessDate, conflict)
      ))
    };
  }

  const ingredientAmountsByFood = new Map<string, number>();
  for (const ingredient of ingredients) {
    ingredientAmountsByFood.set(
      ingredient.foodId,
      roundHalfUp(
        (ingredientAmountsByFood.get(ingredient.foodId) ?? 0) + ingredient.grams,
        1
      )
    );
  }
  const ingredientAmounts = [...ingredientAmountsByFood]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([foodId, grams]) => ({ foodId, grams }));
  if (ingredientAmounts.length < FOOD_DIVERSITY_POLICY_V1.minimumDistinctFoodsPerDay) {
    return {
      kind: 'rejected',
      conflicts: [{ businessDate: input.businessDate, code: 'food_diversity_insufficient' }]
    };
  }

  const coreGroups = new Set<string>();
  for (const ingredient of ingredients) {
    const snapshot = input.snapshotsById.get(ingredient.nutritionSnapshotId);
    if (snapshot !== undefined && CORE_FOOD_GROUPS.has(snapshot.foodGroupId)) {
      coreGroups.add(snapshot.foodGroupId);
    }
  }
  if (coreGroups.size < FOOD_DIVERSITY_POLICY_V1.minimumCoreFoodGroupsPerDay) {
    return {
      kind: 'rejected',
      conflicts: [{ businessDate: input.businessDate, code: 'food_diversity_insufficient' }]
    };
  }

  const nutrition = input.target.nutrition;
  if (nutrition === null || nutrition.kind !== 'feasible') {
    return {
      kind: 'rejected',
      conflicts: [{ businessDate: input.businessDate, code: 'target_nutrition_infeasible' }]
    };
  }
  if (!nutritionWithinRange(evaluation.totals, nutrition)) {
    return {
      kind: 'rejected',
      conflicts: [{ businessDate: input.businessDate, code: 'nutrition_out_of_range' }]
    };
  }

  return {
    kind: 'accepted',
    candidate: {
      day: {
        businessDate: input.businessDate,
        dailyNutritionTargetVersionId: input.target.id,
        dailyMenuTemplateVersionId: input.menu.id,
        locked: false,
        manuallyModified: false,
        meals: orderedMeals.map((meal) => {
          const recipe = input.recipesById.get(meal.recipeTemplateVersionId);
          if (recipe === undefined) throw new Error('Validated recipe is missing');
          return {
            slot: meal.slot,
            recipeTemplateVersionId: meal.recipeTemplateVersionId,
            servingMultiplier: input.multiplier,
            dishNameZh: recipe.dishNameZh,
            ingredients: recipe.ingredients.map((ingredient) => {
              const snapshot = input.snapshotsById.get(ingredient.nutritionSnapshotId);
              if (snapshot === undefined) throw new Error('Validated nutrition snapshot is missing');
              return {
                displayNameZh: snapshot.canonicalNameZh,
                grams: roundHalfUp(ingredient.grams * input.multiplier, 1)
              };
            })
          };
        }),
        ingredientAmounts,
        nutritionTotals: evaluation.totals,
        nutritionSourceSnapshotIds: [...evaluation.sourceSnapshotIds].sort()
      },
      energyDeviation: relativeDeviation(
        evaluation.totals.energyKcal,
        nutrition.targetEnergyKcal
      ),
      proteinDeviation: relativeDeviation(evaluation.totals.proteinG, nutrition.proteinG),
      foodIds: new Set(ingredientAmounts.map(({ foodId }) => foodId))
    }
  };
}

function consumeIfAvailable(
  balances: ReadonlyMap<string, InventoryBalance>,
  ingredientAmounts: MealPlanDay['ingredientAmounts']
): { readonly balances: ReadonlyMap<string, InventoryBalance> } | {
  readonly failure: ConsumptionFailure;
} {
  const next = new Map(balances);
  for (const ingredient of ingredientAmounts) {
    const balance = next.get(ingredient.foodId) ?? {
      availableGrams: 0,
      consumedDecigrams: 0
    };
    const requiredDecigrams = Math.round(ingredient.grams * 10);
    const nextConsumedDecigrams = balance.consumedDecigrams + requiredDecigrams;
    const totalRequiredGrams = nextConsumedDecigrams / 10;
    const comparisonTolerance = Number.EPSILON * Math.max(
      1,
      Math.abs(balance.availableGrams),
      Math.abs(totalRequiredGrams)
    ) * 8;
    if (totalRequiredGrams > balance.availableGrams + comparisonTolerance) {
      return {
        failure: {
          foodId: ingredient.foodId,
          requiredGrams: ingredient.grams,
          availableGrams: balance.availableGrams - balance.consumedDecigrams / 10
        }
      };
    }
    next.set(ingredient.foodId, {
      availableGrams: balance.availableGrams,
      consumedDecigrams: nextConsumedDecigrams
    });
  }
  return { balances: next };
}

function repeatedFoodCount(candidate: ExpandedCandidate, selected: readonly MealPlanDay[]): number {
  const used = new Set(selected.flatMap((day) => (
    day.ingredientAmounts.map(({ foodId }) => foodId)
  )));
  let count = 0;
  for (const foodId of candidate.foodIds) {
    if (used.has(foodId)) count += 1;
  }
  return count;
}

function weeklyDiversitySatisfied(days: readonly MealPlanDay[]): boolean {
  return new Set(days.flatMap((day) => (
    day.ingredientAmounts.map(({ foodId }) => foodId)
  ))).size >= FOOD_DIVERSITY_POLICY_V1.minimumDistinctFoodsPerWeek;
}

function mealTemplateMatchesDay(
  menu: DailyMenuTemplateVersion,
  day: MealPlanDay
): boolean {
  if (menu.meals.length !== day.meals.length) return false;
  const recipeIdBySlot = new Map(menu.meals.map((meal) => [
    meal.slot,
    meal.recipeTemplateVersionId
  ]));
  return day.meals.every((meal) => (
    recipeIdBySlot.get(meal.slot) === meal.recipeTemplateVersionId
  ));
}

function persistedDerivationsMatch(input: {
  readonly day: MealPlanDay;
  readonly ingredientAmounts: MealPlanDay['ingredientAmounts'];
  readonly nutritionTotals: NutrientValues;
  readonly nutritionSourceSnapshotIds: readonly string[];
}): boolean {
  const persistedIngredients = input.day.ingredientAmounts;
  if (persistedIngredients.length !== input.ingredientAmounts.length) return false;
  for (let index = 0; index < persistedIngredients.length; index += 1) {
    const persisted = persistedIngredients[index];
    const rebuilt = input.ingredientAmounts[index];
    if (
      persisted === undefined
      || rebuilt === undefined
      || persisted.foodId !== rebuilt.foodId
      || persisted.grams !== rebuilt.grams
    ) return false;
  }

  const persistedSourceIds = input.day.nutritionSourceSnapshotIds;
  if (persistedSourceIds.length !== input.nutritionSourceSnapshotIds.length) return false;
  for (let index = 0; index < persistedSourceIds.length; index += 1) {
    if (persistedSourceIds[index] !== input.nutritionSourceSnapshotIds[index]) return false;
  }

  const persistedTotals = input.day.nutritionTotals;
  const rebuiltTotals = input.nutritionTotals;
  return persistedTotals.energyKcal === rebuiltTotals.energyKcal
    && persistedTotals.proteinG === rebuiltTotals.proteinG
    && persistedTotals.fatG === rebuiltTotals.fatG
    && persistedTotals.carbohydrateG === rebuiltTotals.carbohydrateG
    && persistedTotals.fiberG === rebuiltTotals.fiberG
    && persistedTotals.saturatedFatG === rebuiltTotals.saturatedFatG
    && persistedTotals.addedSugarG === rebuiltTotals.addedSugarG;
}

function validateFixedDay(input: {
  readonly day: MealPlanDay;
  readonly catalog: DailyMenuCatalogVersion;
  readonly menusById: ReadonlyMap<string, DailyMenuTemplateVersion>;
  readonly recipesById: ReadonlyMap<string, RecipeTemplateVersion>;
  readonly snapshots: readonly NutritionDataSnapshot[];
  readonly inventory: readonly InventoryVersion['items'][number][];
  readonly inventoryByFoodId: ReadonlyMap<string, InventoryVersion['items'][number]>;
  readonly allergens: readonly string[];
  readonly avoidFoodIds: readonly string[];
  readonly allowTestFixtures: boolean;
}): readonly WeeklyMealConflict[] {
  const conflicts: WeeklyMealConflict[] = [];
  const sourceConflict = (foodId?: string): void => {
    conflicts.push({
      businessDate: input.day.businessDate,
      code: 'source_chain_incomplete',
      ...(foodId === undefined ? {} : { foodId })
    });
  };
  const menu = input.menusById.get(input.day.dailyMenuTemplateVersionId);
  if (
    !input.catalog.dailyMenuTemplateVersionIds.includes(input.day.dailyMenuTemplateVersionId)
    || menu === undefined
    || !qualityAllowed(menu, input.allowTestFixtures)
    || !hasRequiredUniqueMealSlots(menu.meals)
  ) {
    sourceConflict();
    return conflicts;
  }
  if (!hasRequiredUniqueMealSlots(input.day.meals)) {
    sourceConflict();
    return conflicts;
  }
  if (!input.day.manuallyModified && !mealTemplateMatchesDay(menu, input.day)) {
    sourceConflict();
    return conflicts;
  }

  const rebuiltIngredients: {
    foodId: string;
    nutritionSnapshotId: string;
    grams: number;
  }[] = [];
  for (const meal of input.day.meals) {
    const recipe = input.recipesById.get(meal.recipeTemplateVersionId);
    if (
      recipe === undefined
      || !qualityAllowed(recipe, input.allowTestFixtures)
      || !WEEKLY_MEAL_SERVING_MULTIPLIERS.includes(meal.servingMultiplier)
    ) {
      sourceConflict();
      return conflicts;
    }
    for (const ingredient of recipe.ingredients) {
      const actualGrams = roundHalfUp(ingredient.grams * meal.servingMultiplier, 1);
      if (actualGrams < 0.1) {
        conflicts.push({
          businessDate: input.day.businessDate,
          code: 'food_diversity_insufficient',
          foodId: ingredient.foodId
        });
      }
      const inventoryItem = input.inventoryByFoodId.get(ingredient.foodId);
      if (
        inventoryItem !== undefined
        && inventoryItem.nutritionSnapshotId !== ingredient.nutritionSnapshotId
      ) sourceConflict(ingredient.foodId);
      rebuiltIngredients.push({
        foodId: ingredient.foodId,
        nutritionSnapshotId: ingredient.nutritionSnapshotId,
        grams: actualGrams
      });
    }
  }
  if (conflicts.length > 0) return conflicts;

  const evaluation = evaluateRecipeCandidate({
    template: {
      id: `fixed-${input.day.businessDate}-${input.day.dailyMenuTemplateVersionId}`,
      templateId: input.day.dailyMenuTemplateVersionId,
      version: 1,
      dishNameZh: input.day.dailyMenuTemplateVersionId,
      sourceId: menu.sourceId,
      datasetVersion: menu.datasetVersion,
      reviewedAt: menu.reviewedAt,
      qualityStatus: menu.qualityStatus,
      ingredients: rebuiltIngredients
    },
    snapshots: input.snapshots,
    inventory: input.inventory,
    allergens: input.allergens,
    avoidFoodIds: input.avoidFoodIds,
    minimumDistinctFoodGroups: 0,
    allowTestFixtures: input.allowTestFixtures
  });
  if (evaluation.kind === 'infeasible') {
    return evaluation.conflicts.map((conflict) => (
      mapRecipeConflict(input.day.businessDate, conflict)
    ));
  }

  const ingredientAmountsByFood = new Map<string, number>();
  for (const ingredient of rebuiltIngredients) {
    ingredientAmountsByFood.set(
      ingredient.foodId,
      roundHalfUp(
        (ingredientAmountsByFood.get(ingredient.foodId) ?? 0) + ingredient.grams,
        1
      )
    );
  }
  const ingredientAmounts = [...ingredientAmountsByFood]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([foodId, grams]) => ({ foodId, grams }));
  if (!persistedDerivationsMatch({
    day: input.day,
    ingredientAmounts,
    nutritionTotals: evaluation.totals,
    nutritionSourceSnapshotIds: [...evaluation.sourceSnapshotIds].sort()
  })) sourceConflict();
  return conflicts;
}

export function generateWeeklyMealPlan(
  input: WeeklyMealGenerationInput
): WeeklyMealGenerationResult {
  const expectedDates = Array.from({ length: 7 }, (_, index) => (
    addBusinessDays(input.weekStartDate, index)
  ));
  const targetByDate = new Map(input.targets.map((target) => [target.businessDate, target]));
  const duplicateTargetDates = input.targets.length !== targetByDate.size;
  if (input.targets.length !== 7 || duplicateTargetDates) {
    const missingDate = expectedDates.find((date) => !targetByDate.has(date)) ?? expectedDates[0];
    return infeasible([{
      businessDate: missingDate ?? input.weekStartDate,
      code: 'target_nutrition_infeasible'
    }]);
  }
  for (const businessDate of expectedDates) {
    const target = targetByDate.get(businessDate);
    if (
      target === undefined
      || target.energy.kind !== 'supported'
      || target.nutrition === null
      || target.nutrition.kind !== 'feasible'
    ) {
      return infeasible([{ businessDate, code: 'target_nutrition_infeasible' }]);
    }
  }

  const expectedDateSet = new Set(expectedDates);
  const seenFixedDates = new Set<string>();
  for (const fixedDay of input.fixedDays) {
    if (!expectedDateSet.has(fixedDay.businessDate) || seenFixedDates.has(fixedDay.businessDate)) {
      return infeasible([{
        businessDate: fixedDay.businessDate,
        code: 'source_chain_incomplete'
      }]);
    }
    seenFixedDates.add(fixedDay.businessDate);
  }

  const fixedByDate = new Map(input.fixedDays.map((day) => [day.businessDate, day]));
  const inventoryByFoodId = new Map(input.inventory.map((item) => [item.foodId, item]));
  const menusById = new Map(input.menus.map((menu) => [menu.id, menu]));
  const recipesById = new Map(input.recipes.map((recipe) => [recipe.id, recipe]));
  const snapshotsById = new Map(input.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  if (!qualityAllowed(input.catalog, input.allowTestFixtures)) {
    return infeasible([{
      businessDate: expectedDates[0] ?? input.weekStartDate,
      code: 'source_chain_incomplete'
    }]);
  }
  let initialBalances: ReadonlyMap<string, InventoryBalance> = new Map(
    input.inventory.map((item) => [item.foodId, {
      availableGrams: item.availableGrams,
      consumedDecigrams: 0
    }])
  );
  for (const businessDate of expectedDates) {
    const fixedDay = fixedByDate.get(businessDate);
    if (fixedDay === undefined) continue;
    const fixedDayConflicts = validateFixedDay({
      day: fixedDay,
      catalog: input.catalog,
      menusById,
      recipesById,
      snapshots: input.snapshots,
      inventory: input.inventory,
      inventoryByFoodId,
      allergens: input.allergens,
      avoidFoodIds: input.avoidFoodIds,
      allowTestFixtures: input.allowTestFixtures
    });
    if (fixedDayConflicts.length > 0) return infeasible(fixedDayConflicts);
    const consumption = consumeIfAvailable(initialBalances, fixedDay.ingredientAmounts);
    if ('failure' in consumption) {
      return infeasible([{
        businessDate,
        code: 'inventory_insufficient',
        ...consumption.failure
      }]);
    }
    initialBalances = consumption.balances;
  }

  const catalogMenuIds = [...new Set(input.catalog.dailyMenuTemplateVersionIds)].sort();
  const candidatesByDate = new Map<string, readonly ExpandedCandidate[]>();

  for (const businessDate of expectedDates) {
    if (fixedByDate.has(businessDate)) continue;
    const target = targetByDate.get(businessDate);
    if (target === undefined) {
      return infeasible([{ businessDate, code: 'target_nutrition_infeasible' }]);
    }
    const accepted: ExpandedCandidate[] = [];
    const rejected: WeeklyMealConflict[] = [];
    for (const menuId of catalogMenuIds) {
      const menu = menusById.get(menuId);
      if (menu === undefined) {
        rejected.push({ businessDate, code: 'source_chain_incomplete' });
        continue;
      }
      for (const multiplier of WEEKLY_MEAL_SERVING_MULTIPLIERS) {
        const expansion = expandCandidate({
          businessDate,
          target,
          menu,
          multiplier,
          recipesById,
          snapshots: input.snapshots,
          snapshotsById,
          inventory: input.inventory,
          inventoryByFoodId,
          allergens: input.allergens.map(canonicalizeAllergenTerm),
          avoidFoodIds: input.avoidFoodIds,
          allowTestFixtures: input.allowTestFixtures
        });
        if (expansion.kind === 'accepted') accepted.push(expansion.candidate);
        else rejected.push(...expansion.conflicts);
      }
    }
    if (accepted.length === 0) {
      return infeasible(rejected.length > 0 ? rejected : [{
        businessDate,
        code: catalogMenuIds.length === 0
          ? 'source_chain_incomplete'
          : 'nutrition_out_of_range'
      }]);
    }
    candidatesByDate.set(businessDate, accepted.sort((left, right) => (
      left.energyDeviation - right.energyDeviation
      || left.proteinDeviation - right.proteinDeviation
      || left.day.dailyMenuTemplateVersionId.localeCompare(right.day.dailyMenuTemplateVersionId)
      || (left.day.meals[0]?.servingMultiplier ?? 0) - (
        right.day.meals[0]?.servingMultiplier ?? 0
      )
    )));
  }

  const selected: MealPlanDay[] = [];
  const recordedFailures: {
    dayIndex: number;
    conflict: WeeklyMealConflict;
  }[] = [];
  const rememberFailure = (dayIndex: number, conflict: WeeklyMealConflict): void => {
    const deepestFailure = recordedFailures[0];
    if (deepestFailure === undefined || dayIndex > deepestFailure.dayIndex) {
      recordedFailures[0] = { dayIndex, conflict };
    }
  };

  function search(
    dayIndex: number,
    balances: ReadonlyMap<string, InventoryBalance>
  ): MealPlanDay[] | null {
    if (dayIndex === expectedDates.length) {
      if (weeklyDiversitySatisfied(selected)) return [...selected];
      const lastDate = expectedDates[expectedDates.length - 1] ?? input.weekStartDate;
      rememberFailure(expectedDates.length - 1, {
        businessDate: lastDate,
        code: 'food_diversity_insufficient'
      });
      return null;
    }
    const businessDate = expectedDates[dayIndex];
    if (businessDate === undefined) return null;
    const fixedDay = fixedByDate.get(businessDate);
    if (fixedDay !== undefined) {
      selected.push(fixedDay);
      const complete = search(dayIndex + 1, balances);
      selected.pop();
      return complete;
    }

    const candidates = [...(candidatesByDate.get(businessDate) ?? [])].sort((left, right) => (
      left.energyDeviation - right.energyDeviation
      || left.proteinDeviation - right.proteinDeviation
      || repeatedFoodCount(left, selected) - repeatedFoodCount(right, selected)
      || left.day.dailyMenuTemplateVersionId.localeCompare(right.day.dailyMenuTemplateVersionId)
      || (left.day.meals[0]?.servingMultiplier ?? 0) - (
        right.day.meals[0]?.servingMultiplier ?? 0
      )
    ));
    for (const candidate of candidates) {
      const consumption = consumeIfAvailable(balances, candidate.day.ingredientAmounts);
      if ('failure' in consumption) {
        rememberFailure(dayIndex, {
          businessDate,
          code: 'inventory_insufficient',
          ...consumption.failure
        });
        continue;
      }
      selected.push(candidate.day);
      const complete = search(dayIndex + 1, consumption.balances);
      selected.pop();
      if (complete !== null) return complete;
    }
    return null;
  }

  const days = search(0, initialBalances);
  if (days === null) {
    const fallback: WeeklyMealConflict = {
      businessDate: expectedDates[expectedDates.length - 1] ?? input.weekStartDate,
      code: 'inventory_insufficient'
    };
    return infeasible([recordedFailures[0]?.conflict ?? fallback]);
  }
  return {
    kind: 'generated',
    policyVersion: WEEKLY_MEAL_GENERATION_V1.policyVersion,
    catalogVersionId: input.catalog.id,
    days
  };
}
