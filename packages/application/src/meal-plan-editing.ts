import {
  dailyMenuCatalogVersionSchema,
  dailyMenuTemplateVersionSchema,
  nutritionDataSnapshotSchema,
  recipeTemplateVersionSchema
} from '@fitness/contracts';
import {
  FOOD_DIVERSITY_POLICY_V1,
  MEAL_PLAN_VALIDATION_V1,
  WEEKLY_MEAL_SERVING_MULTIPLIERS,
  evaluateRecipeCandidate,
  roundHalfUp,
  type WeeklyMealConflict,
  type WeeklyMealInfeasibleResult
} from '@fitness/calculation';
import type {
  BodyProfileVersion,
  CurrentPlanningContext,
  DailyMenuCatalogVersion,
  DailyMenuTemplateVersion,
  DailyNutritionTargetVersion,
  GoalVersion,
  IdempotencyRecord,
  InventoryVersion,
  MealPlanDay,
  MealPlanVersion,
  MealSlot,
  NutrientValues,
  NutritionDataSnapshot,
  NutritionTargetResult,
  PlanningAggregateState,
  RecipeCandidateConflict,
  RecipeTemplateVersion,
  TrainingPlanVersion,
  WriteCommandEnvelope
} from '@fitness/domain';
import { businessDateAt } from './business-time';
import { requestFingerprint } from './idempotency-fingerprint';
import {
  NutritionConstraintsInfeasibleError,
  ProviderUnavailableError,
  createMealPlanGenerationService,
  providerSnapshotToken,
  withReviewedFoodNames,
  type MealPlanGenerationServiceDependencies,
  type MealPlanningProviders
} from './meal-plan-generation';
import { PastFactImmutableError } from './planning-errors';
export { PastFactImmutableError } from './planning-errors';
import {
  IdempotencyKeyReuseError,
  PlanningPrerequisiteError,
  VersionConflictError
} from './versioned-planning';

const CORE_FOOD_GROUPS = new Set([
  'grains_tubers',
  'vegetables',
  'fruit',
  'animal_protein',
  'soy_nuts',
  'dairy'
]);

export interface SelectableRecipeOption {
  readonly recipeTemplateVersionId: string;
  readonly dishNameZh: string;
}

function hasCompleteMealDisplaySnapshot(plan: MealPlanVersion): boolean {
  return plan.days.every((day) => day.meals.every((meal) => (
    meal.dishNameZh !== undefined
    && meal.dishNameZh.trim().length > 0
    && meal.ingredients !== undefined
    && meal.ingredients.length > 0
  )));
}

export type MealPlanEditingServiceDependencies = MealPlanGenerationServiceDependencies;

export class RecipeNotSelectableError extends Error {
  public readonly code = 'recipe_not_selectable' as const;

  public constructor(public readonly recipeTemplateVersionId: string) {
    super(`Recipe is not selectable: ${recipeTemplateVersionId}`);
    this.name = 'RecipeNotSelectableError';
  }
}

export interface ManualMealReplacementInput {
  readonly currentPlan: MealPlanVersion;
  readonly businessDate: string;
  readonly slot: MealSlot;
  readonly replacementRecipe: RecipeTemplateVersion;
  readonly recipes: readonly RecipeTemplateVersion[];
  readonly snapshots: readonly NutritionDataSnapshot[];
  readonly inventory: InventoryVersion;
  readonly target: DailyNutritionTargetVersion;
  readonly allergens: readonly string[];
  readonly avoidFoodIds: readonly string[];
  readonly allowTestFixtures: boolean;
}

interface ProviderSnapshot {
  readonly catalog: DailyMenuCatalogVersion;
  readonly menus: readonly DailyMenuTemplateVersion[];
  readonly recipes: readonly RecipeTemplateVersion[];
  readonly snapshots: readonly NutritionDataSnapshot[];
  readonly selectableRecipes: readonly SelectableRecipeOption[];
}

interface EditingPrerequisites {
  readonly profile: BodyProfileVersion;
  readonly goal: GoalVersion;
  readonly trainingPlan: TrainingPlanVersion;
  readonly mealPlan: MealPlanVersion;
  readonly inventory: InventoryVersion;
  readonly target: DailyNutritionTargetVersion;
  readonly token: {
    readonly profileVersionId: string;
    readonly goalVersionId: string;
    readonly trainingPlanVersionId: string;
    readonly mealPlanVersionId: string;
    readonly inventoryVersionId: string;
    readonly targetVersionId: string;
  };
}

function findById<T extends { readonly id: string }>(
  values: readonly T[],
  id: string | null
): T | null {
  if (id === null) return null;
  return values.find((value) => value.id === id) ?? null;
}

function findRecord(
  state: PlanningAggregateState,
  operation: 'setMealPlanDayLock' | 'updateMealPlanDay',
  key: string
): Extract<IdempotencyRecord, { readonly operation: typeof operation }> | undefined {
  return state.idempotencyRecords.find(
    (record): record is Extract<IdempotencyRecord, { readonly operation: typeof operation }> => (
      record.operation === operation && record.key === key
    )
  );
}

function assertReplay(
  record: IdempotencyRecord,
  expectedFingerprint: string,
  idempotencyKey: string
): void {
  if (record.requestFingerprint !== expectedFingerprint) {
    throw new IdempotencyKeyReuseError(idempotencyKey);
  }
}

function replayMealPlan(state: PlanningAggregateState, resultVersionId: string): MealPlanVersion {
  const previous = findById(state.mealPlans, resultVersionId);
  if (previous === null) throw new Error('Stored idempotency result is missing');
  return previous;
}

function sourceAllowed(
  value: { readonly qualityStatus: 'reviewed' | 'test_fixture' },
  allowTestFixtures: boolean
): boolean {
  return value.qualityStatus === 'reviewed' || allowTestFixtures;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

async function loadProviderSnapshot(input: {
  readonly providers: MealPlanningProviders;
  readonly currentPlan: MealPlanVersion | null;
  readonly requestedRecipeVersionId?: string | undefined;
}): Promise<ProviderSnapshot> {
  const { providers } = input;
  try {
    const catalog = dailyMenuCatalogVersionSchema.parse(
      await providers.menus.getActiveCatalog()
    );
    if (!sourceAllowed(catalog, providers.allowTestFixtures)) {
      throw new ProviderUnavailableError('meal_catalog_unavailable');
    }
    const menus: DailyMenuTemplateVersion[] = [];
    for (const id of [...new Set(catalog.dailyMenuTemplateVersionIds)].sort()) {
      const menu = dailyMenuTemplateVersionSchema.parse(
        await providers.menus.getMenuByVersionId(id)
      );
      if (menu.id !== id || !sourceAllowed(menu, providers.allowTestFixtures)) {
        throw new ProviderUnavailableError('meal_catalog_unavailable');
      }
      menus.push(menu);
    }
    const selectableRecipeIds = new Set(
      menus.flatMap((menu) => menu.meals.map((meal) => meal.recipeTemplateVersionId))
    );
    if (
      input.requestedRecipeVersionId !== undefined
      && !selectableRecipeIds.has(input.requestedRecipeVersionId)
    ) {
      throw new RecipeNotSelectableError(input.requestedRecipeVersionId);
    }
    const currentRecipeIds = input.currentPlan?.days.flatMap((day) => (
      day.meals.map((meal) => meal.recipeTemplateVersionId)
    )) ?? [];
    const recipeIds = [...new Set([...selectableRecipeIds, ...currentRecipeIds])].sort();
    const recipes: RecipeTemplateVersion[] = [];
    for (const id of recipeIds) {
      const recipe = recipeTemplateVersionSchema.parse(
        await providers.recipes.getByVersionId(id)
      );
      if (recipe.id !== id || !sourceAllowed(recipe, providers.allowTestFixtures)) {
        throw new ProviderUnavailableError('meal_catalog_unavailable');
      }
      recipes.push(recipe);
    }
    const snapshotIds = [...new Set(recipes.flatMap((recipe) => (
      recipe.ingredients.map((ingredient) => ingredient.nutritionSnapshotId)
    )))].sort();
    const snapshots: NutritionDataSnapshot[] = [];
    for (const id of snapshotIds) {
      const snapshot = nutritionDataSnapshotSchema.parse(
        await providers.nutrition.getSnapshot(id)
      );
      if (snapshot.id !== id || !sourceAllowed(snapshot, providers.allowTestFixtures)) {
        throw new ProviderUnavailableError('nutrition_source_unavailable');
      }
      snapshots.push(snapshot);
    }
    const selectableRecipes = recipes
      .filter((recipe) => selectableRecipeIds.has(recipe.id))
      .map((recipe) => ({
        recipeTemplateVersionId: recipe.id,
        dishNameZh: recipe.dishNameZh
      }))
      .sort((left, right) => (
        left.recipeTemplateVersionId.localeCompare(right.recipeTemplateVersionId)
      ));
    return cloneAndFreeze({ catalog, menus, recipes, snapshots, selectableRecipes });
  } catch (error: unknown) {
    if (error instanceof ProviderUnavailableError || error instanceof RecipeNotSelectableError) {
      throw error;
    }
    throw new ProviderUnavailableError('meal_catalog_unavailable');
  }
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
      || left.code.localeCompare(right.code)
      || (left.foodId ?? '').localeCompare(right.foodId ?? '')
    ))
  };
}

function relativeDeviation(actual: number, target: number): number {
  return Math.abs(actual - target) / target;
}

function withinInclusive(value: number, minimum: number, maximum: number): boolean {
  const tolerance = Number.EPSILON * Math.max(
    1,
    Math.abs(value),
    Math.abs(minimum),
    Math.abs(maximum)
  ) * 8;
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
  if (totals.energyKcal <= 0 || target.targetEnergyKcal <= 0 || target.proteinG <= 0) {
    return false;
  }
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
  return withinInclusive(fatShare, policy.fatEnergyRange.minInclusive, policy.fatEnergyRange.maxInclusive)
    && withinInclusive(
      carbohydrateShare,
      policy.carbohydrateEnergyRange.minInclusive,
      policy.carbohydrateEnergyRange.maxInclusive
    )
    && totals.carbohydrateG >= policy.carbohydrateMinimumG
    && withinInclusive(totals.fiberG, policy.fiberRangeG.minInclusive, policy.fiberRangeG.maxInclusive)
    && belowExclusive(saturatedFatShare, policy.saturatedFatEnergyMaxExclusive)
    && belowExclusive(addedSugarShare, policy.addedSugarEnergyMaxExclusive);
}

function wholeWeekInventoryConflict(input: {
  readonly plan: MealPlanVersion;
  readonly replacementDay: MealPlanDay;
  readonly inventory: InventoryVersion;
}): WeeklyMealConflict | null {
  const usage = new Map<string, number>();
  for (const day of input.plan.days) {
    const effectiveDay = day.businessDate === input.replacementDay.businessDate
      ? input.replacementDay
      : day;
    for (const amount of effectiveDay.ingredientAmounts) {
      usage.set(amount.foodId, roundHalfUp((usage.get(amount.foodId) ?? 0) + amount.grams, 1));
    }
  }
  const inventory = new Map(input.inventory.items.map((item) => [item.foodId, item.availableGrams]));
  for (const [foodId, requiredGrams] of [...usage].sort(([left], [right]) => (
    left.localeCompare(right)
  ))) {
    const availableGrams = inventory.get(foodId) ?? 0;
    if (requiredGrams > availableGrams) {
      return {
        businessDate: input.replacementDay.businessDate,
        code: 'inventory_insufficient',
        foodId,
        requiredGrams,
        availableGrams
      };
    }
  }
  return null;
}

function wholeWeekDiversityConflict(input: {
  readonly plan: MealPlanVersion;
  readonly replacementDay: MealPlanDay;
}): WeeklyMealConflict | null {
  const foodIds = new Set(input.plan.days.flatMap((day) => {
    const effectiveDay = day.businessDate === input.replacementDay.businessDate
      ? input.replacementDay
      : day;
    return effectiveDay.ingredientAmounts
      .filter((amount) => amount.grams > 0)
      .map((amount) => amount.foodId);
  }));
  return foodIds.size < FOOD_DIVERSITY_POLICY_V1.minimumDistinctFoodsPerWeek
    ? {
        businessDate: input.replacementDay.businessDate,
        code: 'food_diversity_insufficient'
      }
    : null;
}

export function selectManualMealReplacement(
  input: ManualMealReplacementInput
): MealPlanDay | WeeklyMealInfeasibleResult {
  const currentDay = input.currentPlan.days.find(
    (day) => day.businessDate === input.businessDate
  );
  if (
    currentDay === undefined
    || input.target.businessDate !== input.businessDate
    || !currentDay.meals.some((meal) => meal.slot === input.slot)
    || input.target.energy.kind !== 'supported'
    || input.target.nutrition === null
    || input.target.nutrition.kind !== 'feasible'
  ) {
    return infeasible([{
      businessDate: input.businessDate,
      code: 'target_nutrition_infeasible'
    }]);
  }
  const recipesById = new Map(input.recipes.map((recipe) => [recipe.id, recipe]));
  recipesById.set(input.replacementRecipe.id, input.replacementRecipe);
  const snapshotsById = new Map(input.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const inventoryByFoodId = new Map(input.inventory.items.map((item) => [item.foodId, item]));
  const accepted: {
    readonly day: MealPlanDay;
    readonly energyDeviation: number;
    readonly proteinDeviation: number;
    readonly recipeId: string;
    readonly multiplier: number;
  }[] = [];
  const rejected: WeeklyMealConflict[] = [];

  for (const multiplier of WEEKLY_MEAL_SERVING_MULTIPLIERS) {
    const meals = currentDay.meals.map((meal) => meal.slot === input.slot
      ? {
          slot: meal.slot,
          recipeTemplateVersionId: input.replacementRecipe.id,
          servingMultiplier: multiplier
        }
      : meal);
    const ingredients: {
      readonly foodId: string;
      readonly nutritionSnapshotId: string;
      readonly grams: number;
    }[] = [];
    let sourceBroken = false;
    let ingredientRoundedToZero = false;
    for (const meal of meals) {
      const recipe = recipesById.get(meal.recipeTemplateVersionId);
      if (recipe === undefined || !sourceAllowed(recipe, input.allowTestFixtures)) {
        sourceBroken = true;
        break;
      }
      for (const ingredient of recipe.ingredients) {
        const actualGrams = roundHalfUp(ingredient.grams * meal.servingMultiplier, 1);
        if (actualGrams < 0.1) {
          rejected.push({
            businessDate: input.businessDate,
            code: 'food_diversity_insufficient',
            foodId: ingredient.foodId
          });
          ingredientRoundedToZero = true;
          break;
        }
        const inventoryItem = inventoryByFoodId.get(ingredient.foodId);
        if (
          inventoryItem !== undefined
          && inventoryItem.nutritionSnapshotId !== ingredient.nutritionSnapshotId
        ) {
          sourceBroken = true;
          break;
        }
        ingredients.push({
          foodId: ingredient.foodId,
          nutritionSnapshotId: ingredient.nutritionSnapshotId,
          grams: actualGrams
        });
      }
      if (sourceBroken || ingredientRoundedToZero) break;
    }
    if (ingredientRoundedToZero) continue;
    if (sourceBroken) {
      rejected.push({ businessDate: input.businessDate, code: 'source_chain_incomplete' });
      continue;
    }
    const evaluation = evaluateRecipeCandidate({
      template: {
        id: `manual-${input.businessDate}-${input.slot}-${String(multiplier)}`,
        templateId: input.replacementRecipe.templateId,
        version: 1,
        dishNameZh: input.replacementRecipe.dishNameZh,
        sourceId: input.replacementRecipe.sourceId,
        datasetVersion: input.replacementRecipe.datasetVersion,
        reviewedAt: input.replacementRecipe.reviewedAt,
        qualityStatus: input.replacementRecipe.qualityStatus,
        ingredients
      },
      snapshots: input.snapshots,
      inventory: input.inventory.items,
      allergens: input.allergens,
      avoidFoodIds: input.avoidFoodIds,
      minimumDistinctFoodGroups: 0,
      allowTestFixtures: input.allowTestFixtures
    });
    if (evaluation.kind === 'infeasible') {
      rejected.push(...evaluation.conflicts.map((conflict) => (
        mapRecipeConflict(input.businessDate, conflict)
      )));
      continue;
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
    const coreGroups = new Set(
      ingredients.flatMap((ingredient) => {
        const group = snapshotsById.get(ingredient.nutritionSnapshotId)?.foodGroupId;
        return group !== undefined && CORE_FOOD_GROUPS.has(group) ? [group] : [];
      })
    );
    if (
      ingredientAmounts.length < FOOD_DIVERSITY_POLICY_V1.minimumDistinctFoodsPerDay
      || coreGroups.size < FOOD_DIVERSITY_POLICY_V1.minimumCoreFoodGroupsPerDay
    ) {
      rejected.push({ businessDate: input.businessDate, code: 'food_diversity_insufficient' });
      continue;
    }
    if (!nutritionWithinRange(evaluation.totals, input.target.nutrition)) {
      rejected.push({ businessDate: input.businessDate, code: 'nutrition_out_of_range' });
      continue;
    }
    const day: MealPlanDay = {
      ...currentDay,
      dailyNutritionTargetVersionId: input.target.id,
      locked: true,
      manuallyModified: true,
      meals: meals.map((meal) => {
        const recipe = recipesById.get(meal.recipeTemplateVersionId);
        if (recipe === undefined) throw new Error('Validated recipe is missing');
        return {
          ...meal,
          dishNameZh: recipe.dishNameZh,
          ingredients: recipe.ingredients.map((ingredient) => {
            const snapshot = snapshotsById.get(ingredient.nutritionSnapshotId);
            if (snapshot === undefined) throw new Error('Validated nutrition snapshot is missing');
            return {
              displayNameZh: snapshot.canonicalNameZh,
              grams: roundHalfUp(ingredient.grams * meal.servingMultiplier, 1)
            };
          })
        };
      }),
      ingredientAmounts,
      nutritionTotals: evaluation.totals,
      nutritionSourceSnapshotIds: [...evaluation.sourceSnapshotIds].sort()
    };
    const diversityConflict = wholeWeekDiversityConflict({
      plan: input.currentPlan,
      replacementDay: day
    });
    if (diversityConflict !== null) {
      rejected.push(diversityConflict);
      continue;
    }
    const inventoryConflict = wholeWeekInventoryConflict({
      plan: input.currentPlan,
      replacementDay: day,
      inventory: input.inventory
    });
    if (inventoryConflict !== null) {
      rejected.push(inventoryConflict);
      continue;
    }
    accepted.push({
      day,
      energyDeviation: relativeDeviation(
        evaluation.totals.energyKcal,
        input.target.nutrition.targetEnergyKcal
      ),
      proteinDeviation: relativeDeviation(
        evaluation.totals.proteinG,
        input.target.nutrition.proteinG
      ),
      recipeId: input.replacementRecipe.id,
      multiplier
    });
  }
  const selected = accepted.sort((left, right) => (
    left.energyDeviation - right.energyDeviation
    || left.proteinDeviation - right.proteinDeviation
    || left.recipeId.localeCompare(right.recipeId)
    || left.multiplier - right.multiplier
  ))[0];
  return selected?.day ?? infeasible(rejected.length > 0 ? rejected : [{
    businessDate: input.businessDate,
    code: 'nutrition_out_of_range'
  }]);
}

function targetsForActiveWeek(
  state: PlanningAggregateState,
  profile: BodyProfileVersion,
  goal: GoalVersion,
  trainingPlan: TrainingPlanVersion
): readonly DailyNutritionTargetVersion[] {
  const relatedPlanIds = new Set(state.trainingPlans.filter((candidate) => (
    candidate.bodyProfileVersionId === profile.id
    && candidate.goalVersionId === goal.id
    && candidate.payload.weekStartDate === trainingPlan.payload.weekStartDate
  )).map((candidate) => candidate.id));
  const latestByDate = new Map<string, DailyNutritionTargetVersion>();
  for (const target of state.dailyNutritionTargets) {
    if (
      target.bodyProfileVersionId !== profile.id
      || target.goalVersionId !== goal.id
      || !relatedPlanIds.has(target.trainingPlanVersionId)
    ) continue;
    const previous = latestByDate.get(target.businessDate);
    if (previous === undefined || target.version > previous.version) {
      latestByDate.set(target.businessDate, target);
    }
  }
  return [...latestByDate.values()].sort((left, right) => (
    left.businessDate.localeCompare(right.businessDate)
  ));
}

function editingPrerequisites(
  state: PlanningAggregateState,
  businessDate: string
): EditingPrerequisites {
  const profile = findById(state.bodyProfiles, state.activeBodyProfileVersionId);
  if (profile === null) throw new PlanningPrerequisiteError('body_profile');
  const goal = findById(state.goals, state.activeGoalVersionId);
  if (goal === null || goal.bodyProfileVersionId !== profile.id) {
    throw new PlanningPrerequisiteError('goal');
  }
  const trainingPlan = findById(state.trainingPlans, state.activeTrainingPlanVersionId);
  if (
    trainingPlan === null
    || trainingPlan.bodyProfileVersionId !== profile.id
    || trainingPlan.goalVersionId !== goal.id
  ) throw new PlanningPrerequisiteError('training_plan');
  const mealPlan = findById(state.mealPlans, state.activeMealPlanVersionId);
  if (
    mealPlan === null
    || mealPlan.readiness !== 'complete'
    || mealPlan.bodyProfileVersionId !== profile.id
    || mealPlan.goalVersionId !== goal.id
    || mealPlan.trainingPlanVersionId !== trainingPlan.id
  ) throw new PlanningPrerequisiteError('daily_nutrition_targets');
  const inventory = findById(state.inventories, state.activeInventoryVersionId);
  if (inventory === null) throw new PlanningPrerequisiteError('inventory');
  const target = targetsForActiveWeek(state, profile, goal, trainingPlan).find(
    (candidate) => candidate.businessDate === businessDate
  );
  if (target === undefined) throw new PlanningPrerequisiteError('daily_nutrition_targets');
  return {
    profile,
    goal,
    trainingPlan,
    mealPlan,
    inventory,
    target,
    token: {
      profileVersionId: profile.id,
      goalVersionId: goal.id,
      trainingPlanVersionId: trainingPlan.id,
      mealPlanVersionId: mealPlan.id,
      inventoryVersionId: inventory.id,
      targetVersionId: target.id
    }
  };
}

function tokensEqual(
  left: EditingPrerequisites['token'],
  right: EditingPrerequisites['token']
): boolean {
  return left.profileVersionId === right.profileVersionId
    && left.goalVersionId === right.goalVersionId
    && left.trainingPlanVersionId === right.trainingPlanVersionId
    && left.mealPlanVersionId === right.mealPlanVersionId
    && left.inventoryVersionId === right.inventoryVersionId
    && left.targetVersionId === right.targetVersionId;
}

function assertFutureBusinessDate(
  businessDate: string,
  profile: BodyProfileVersion,
  instant: string
): void {
  const today = businessDateAt(instant, profile.payload.businessTimezone);
  if (businessDate <= today) throw new PastFactImmutableError(businessDate);
}

function successor(input: {
  readonly userId: string;
  readonly previous: MealPlanVersion;
  readonly inventoryVersionId: string;
  readonly catalogVersionId: string;
  readonly replacementDay: MealPlanDay;
  readonly createdAt: string;
  readonly id: string;
  readonly version: number;
}): MealPlanVersion {
  return {
    ...input.previous,
    id: input.id,
    userId: input.userId,
    version: input.version,
    createdAt: input.createdAt,
    inventoryVersionId: input.inventoryVersionId,
    catalogVersionId: input.catalogVersionId,
    supersedesVersionId: input.previous.id,
    readiness: 'complete',
    days: input.previous.days.map((day) => (
      day.businessDate === input.replacementDay.businessDate
        ? input.replacementDay
        : day
    ))
  };
}

export function createMealPlanEditingService(
  dependencies: MealPlanEditingServiceDependencies
) {
  const { repository, providers, now, nextId } = dependencies;
  const base = createMealPlanGenerationService(dependencies);
  return {
    ...base,

    async getCurrentContext(userId: string) {
      const context = await base.getCurrentContext(userId);
      let selectableRecipes: readonly SelectableRecipeOption[] = [];
      let selectableRecipesStatus: CurrentPlanningContext['selectableRecipesStatus'] = 'no_options';
      if (context.mealPlan === null || !hasCompleteMealDisplaySnapshot(context.mealPlan)) {
        return { ...context, selectableRecipes, selectableRecipesStatus };
      }
      try {
        selectableRecipes = (await loadProviderSnapshot({
          providers,
          currentPlan: context.mealPlan
        })).selectableRecipes;
        selectableRecipesStatus = selectableRecipes.length > 0 ? 'available' : 'no_options';
      } catch {
        selectableRecipes = [];
        selectableRecipesStatus = 'provider_unavailable';
      }
      return { ...context, selectableRecipes, selectableRecipesStatus };
    },

    async setMealPlanDayLock(
      userId: string,
      envelope: WriteCommandEnvelope<{
        readonly businessDate: string;
        readonly locked: boolean;
      }>
    ): Promise<MealPlanVersion> {
      const expectedFingerprint = requestFingerprint({
        expectedVersion: envelope.expectedVersion,
        payload: envelope.payload
      });
      return repository.transact(userId, (state) => {
        const replay = findRecord(state, 'setMealPlanDayLock', envelope.idempotencyKey);
        if (replay !== undefined) {
          assertReplay(replay, expectedFingerprint, envelope.idempotencyKey);
          return { nextState: state, result: replayMealPlan(state, replay.resultVersionId) };
        }
        if (envelope.expectedVersion !== state.mealPlans.length) {
          throw new VersionConflictError(envelope.expectedVersion, state.mealPlans.length);
        }
        const createdAt = now();
        const activeProfile = findById(state.bodyProfiles, state.activeBodyProfileVersionId);
        if (activeProfile === null) throw new PlanningPrerequisiteError('body_profile');
        assertFutureBusinessDate(envelope.payload.businessDate, activeProfile, createdAt);
        const current = editingPrerequisites(state, envelope.payload.businessDate);
        const currentDay = current.mealPlan.days.find(
          (day) => day.businessDate === envelope.payload.businessDate
        );
        if (currentDay === undefined) {
          throw new PlanningPrerequisiteError('daily_nutrition_targets');
        }
        const mealPlan = successor({
          userId,
          previous: current.mealPlan,
          inventoryVersionId: current.mealPlan.inventoryVersionId,
          catalogVersionId: current.mealPlan.catalogVersionId,
          replacementDay: { ...currentDay, locked: envelope.payload.locked },
          createdAt,
          id: nextId('meal-plan'),
          version: state.mealPlans.length + 1
        });
        const record: IdempotencyRecord = {
          operation: 'setMealPlanDayLock',
          key: envelope.idempotencyKey,
          requestFingerprint: expectedFingerprint,
          resultVersionId: mealPlan.id
        };
        return {
          nextState: {
            ...state,
            mealPlans: [...state.mealPlans, mealPlan],
            activeMealPlanVersionId: mealPlan.id,
            idempotencyRecords: [...state.idempotencyRecords, record]
          },
          result: mealPlan
        };
      });
    },

    async updateMealPlanDay(
      userId: string,
      envelope: WriteCommandEnvelope<{
        readonly businessDate: string;
        readonly slot: MealSlot;
        readonly recipeTemplateVersionId: string;
      }>
    ): Promise<MealPlanVersion> {
      const expectedFingerprint = requestFingerprint({
        expectedVersion: envelope.expectedVersion,
        payload: envelope.payload
      });
      const initialState = await repository.read(userId);
      const initialReplay = findRecord(
        initialState,
        'updateMealPlanDay',
        envelope.idempotencyKey
      );
      if (initialReplay !== undefined) {
        assertReplay(initialReplay, expectedFingerprint, envelope.idempotencyKey);
        return replayMealPlan(initialState, initialReplay.resultVersionId);
      }
      if (envelope.expectedVersion !== initialState.mealPlans.length) {
        throw new VersionConflictError(envelope.expectedVersion, initialState.mealPlans.length);
      }
      const activeProfile = findById(
        initialState.bodyProfiles,
        initialState.activeBodyProfileVersionId
      );
      if (activeProfile === null) throw new PlanningPrerequisiteError('body_profile');
      assertFutureBusinessDate(envelope.payload.businessDate, activeProfile, now());
      const initial = editingPrerequisites(initialState, envelope.payload.businessDate);
      const providerSnapshot = await loadProviderSnapshot({
        providers,
        currentPlan: initial.mealPlan,
        requestedRecipeVersionId: envelope.payload.recipeTemplateVersionId
      });
      const replacementRecipe = providerSnapshot.recipes.find(
        (recipe) => recipe.id === envelope.payload.recipeTemplateVersionId
      );
      if (replacementRecipe === undefined) {
        throw new RecipeNotSelectableError(envelope.payload.recipeTemplateVersionId);
      }
      const selected = selectManualMealReplacement({
        currentPlan: initial.mealPlan,
        businessDate: envelope.payload.businessDate,
        slot: envelope.payload.slot,
        replacementRecipe,
        recipes: providerSnapshot.recipes,
        snapshots: providerSnapshot.snapshots,
        inventory: initial.inventory,
        target: initial.target,
        allergens: initial.profile.payload.allergens,
        avoidFoodIds: initial.profile.payload.avoidFoods,
        allowTestFixtures: providers.allowTestFixtures
      });
      if ('kind' in selected) {
        throw new NutritionConstraintsInfeasibleError(
          withReviewedFoodNames(selected.conflicts, providerSnapshot.snapshots)
        );
      }
      const initialProviderSnapshotToken = providerSnapshotToken(providerSnapshot);
      const commitProviderSnapshotToken = providerSnapshotToken(
        await loadProviderSnapshot({
          providers,
          currentPlan: initial.mealPlan
        })
      );
      if (commitProviderSnapshotToken !== initialProviderSnapshotToken) {
        throw new VersionConflictError(envelope.expectedVersion, initialState.mealPlans.length);
      }
      return repository.transact(userId, (state) => {
        const replay = findRecord(state, 'updateMealPlanDay', envelope.idempotencyKey);
        if (replay !== undefined) {
          assertReplay(replay, expectedFingerprint, envelope.idempotencyKey);
          return { nextState: state, result: replayMealPlan(state, replay.resultVersionId) };
        }
        if (envelope.expectedVersion !== state.mealPlans.length) {
          throw new VersionConflictError(envelope.expectedVersion, state.mealPlans.length);
        }
        const current = editingPrerequisites(state, envelope.payload.businessDate);
        if (!tokensEqual(initial.token, current.token)) {
          throw new VersionConflictError(envelope.expectedVersion, state.mealPlans.length);
        }
        const createdAt = now();
        assertFutureBusinessDate(envelope.payload.businessDate, current.profile, createdAt);
        const mealPlan = successor({
          userId,
          previous: current.mealPlan,
          inventoryVersionId: current.inventory.id,
          catalogVersionId: providerSnapshot.catalog.id,
          replacementDay: selected,
          createdAt,
          id: nextId('meal-plan'),
          version: state.mealPlans.length + 1
        });
        const record: IdempotencyRecord = {
          operation: 'updateMealPlanDay',
          key: envelope.idempotencyKey,
          requestFingerprint: expectedFingerprint,
          resultVersionId: mealPlan.id
        };
        return {
          nextState: {
            ...state,
            mealPlans: [...state.mealPlans, mealPlan],
            activeMealPlanVersionId: mealPlan.id,
            idempotencyRecords: [...state.idempotencyRecords, record]
          },
          result: mealPlan
        };
      });
    }
  };
}
