import {
  dailyMenuCatalogVersionSchema,
  dailyMenuTemplateVersionSchema,
  nutritionDataSnapshotSchema,
  recipeTemplateVersionSchema
} from '@fitness/contracts';
import {
  generateWeeklyMealPlan as generateDeterministicWeeklyMealPlan,
  type WeeklyMealConflict
} from '@fitness/calculation';
import type {
  BodyProfileVersion,
  DailyMenuCatalogProvider,
  DailyMenuCatalogVersion,
  DailyMenuTemplateVersion,
  DailyNutritionTargetVersion,
  FoodResolution,
  GoalVersion,
  IdempotencyRecord,
  InventoryVersion,
  MealPlanVersion,
  NutritionDataSnapshot,
  NutritionProvider,
  PlanningAggregateState,
  RecipeTemplateProvider,
  RecipeTemplateVersion,
  TrainingPlanVersion,
  WriteCommandEnvelope
} from '@fitness/domain';
import { requestFingerprint } from './idempotency-fingerprint';
import {
  IdempotencyKeyReuseError,
  PlanningPrerequisiteError,
  VersionConflictError,
  createVersionedPlanningService,
  type VersionedPlanningServiceDependencies
} from './versioned-planning';

export interface MealPlanningProviders {
  readonly nutrition: NutritionProvider;
  readonly recipes: RecipeTemplateProvider;
  readonly menus: DailyMenuCatalogProvider;
  readonly allowTestFixtures: boolean;
}

export interface MealGenerationCompareToken {
  readonly bodyProfileVersionId: string;
  readonly goalVersionId: string;
  readonly trainingPlanVersionId: string;
  readonly inventoryVersionId: string;
  readonly dailyNutritionTargetVersionIds: readonly string[];
}

export interface MealPlanGenerationServiceDependencies
  extends VersionedPlanningServiceDependencies {
  readonly providers: MealPlanningProviders;
}

export class ProviderUnavailableError extends Error {
  public readonly code = 'provider_unavailable' as const;

  public constructor(
    public readonly reason:
      | 'food_name_unresolved'
      | 'nutrition_source_unavailable'
      | 'meal_catalog_unavailable'
  ) {
    super(`Meal planning provider is unavailable: ${reason}`);
    this.name = 'ProviderUnavailableError';
  }
}

export class NutritionConstraintsInfeasibleError extends Error {
  public readonly code = 'nutrition_constraints_infeasible' as const;

  public constructor(
    public readonly conflicts: readonly (Omit<WeeklyMealConflict, 'foodId'> & {
      readonly foodNameZh?: string | undefined;
    })[]
  ) {
    super(`Weekly meal constraints are infeasible: ${JSON.stringify(conflicts)}`);
    this.name = 'NutritionConstraintsInfeasibleError';
  }
}

export function withReviewedFoodNames(
  conflicts: readonly WeeklyMealConflict[],
  snapshots: readonly NutritionDataSnapshot[]
): NutritionConstraintsInfeasibleError['conflicts'] {
  const namesByFoodId = new Map(
    snapshots.map((snapshot) => [snapshot.foodId, snapshot.canonicalNameZh] as const)
  );
  return conflicts.map(({ foodId, ...conflict }) => ({
    ...conflict,
    ...(foodId === undefined || namesByFoodId.get(foodId) === undefined
      ? {}
      : { foodNameZh: namesByFoodId.get(foodId) })
  }));
}

interface ResolvedInventoryItem {
  readonly foodId: string;
  readonly nutritionSnapshotId: string;
  readonly availableGrams: number;
}

function normalizeInventoryRequestName(value: string): string {
  return value.trim().replaceAll(/\s+/g, '').toLocaleLowerCase('zh-CN');
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function inventoryRequestFingerprint(
  envelope: WriteCommandEnvelope<{
    readonly items: readonly { readonly name: string; readonly availableGrams: number }[];
  }>
): string {
  const gramsByName = new Map<string, number[]>();
  for (const item of envelope.payload.items) {
    if (!Number.isFinite(item.availableGrams) || item.availableGrams <= 0) {
      throw new ProviderUnavailableError('food_name_unresolved');
    }
    const name = normalizeInventoryRequestName(item.name);
    const grams = gramsByName.get(name) ?? [];
    grams.push(item.availableGrams);
    gramsByName.set(name, grams);
  }
  const items = [...gramsByName.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([name, grams]) => ({
      name,
      availableGrams: [...grams]
        .sort((left, right) => left - right)
        .reduce((sum, value) => sum + value, 0)
    }));
  return requestFingerprint({
    expectedVersion: envelope.expectedVersion,
    payload: { items }
  });
}

export interface GenerationPrerequisites {
  readonly bodyProfile: BodyProfileVersion;
  readonly goal: GoalVersion;
  readonly trainingPlan: TrainingPlanVersion;
  readonly inventory: InventoryVersion;
  readonly targets: readonly DailyNutritionTargetVersion[];
  readonly compareToken: MealGenerationCompareToken;
}

export interface ProviderSnapshot {
  readonly catalog: DailyMenuCatalogVersion;
  readonly menus: readonly DailyMenuTemplateVersion[];
  readonly recipes: readonly RecipeTemplateVersion[];
  readonly snapshots: readonly NutritionDataSnapshot[];
}

export function providerSnapshotToken(snapshot: ProviderSnapshot): string {
  return `provider-graph-v1:${requestFingerprint({
    catalog: {
      ...snapshot.catalog,
      dailyMenuTemplateVersionIds: [...snapshot.catalog.dailyMenuTemplateVersionIds]
        .sort(compareCodeUnits)
    },
    menus: [...snapshot.menus]
      .sort((left, right) => compareCodeUnits(left.id, right.id))
      .map((menu) => ({
        ...menu,
        meals: [...menu.meals].sort((left, right) => (
          compareCodeUnits(left.slot, right.slot)
          || compareCodeUnits(left.recipeTemplateVersionId, right.recipeTemplateVersionId)
        ))
      })),
    recipes: [...snapshot.recipes]
      .sort((left, right) => compareCodeUnits(left.id, right.id))
      .map((recipe) => ({
        ...recipe,
        ingredients: [...recipe.ingredients].sort((left, right) => (
          compareCodeUnits(left.foodId, right.foodId)
          || compareCodeUnits(left.nutritionSnapshotId, right.nutritionSnapshotId)
          || left.grams - right.grams
        ))
      })),
    nutritionSnapshots: [...snapshot.snapshots]
      .sort((left, right) => compareCodeUnits(left.id, right.id))
      .map((nutrition) => ({
        ...nutrition,
        allergens: [...nutrition.allergens].sort(compareCodeUnits)
      }))
  })}`;
}

function findById<T extends { readonly id: string }>(values: readonly T[], id: string | null): T | null {
  if (id === null) return null;
  return values.find((value) => value.id === id) ?? null;
}

function findRecord(
  state: PlanningAggregateState,
  operation: 'saveInventory' | 'generateWeeklyMealPlan',
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

function sourceAllowed(
  value: { readonly qualityStatus: 'reviewed' | 'test_fixture' },
  allowTestFixtures: boolean
): boolean {
  return value.qualityStatus === 'reviewed' || allowTestFixtures;
}

function cloneAndFreeze<T>(value: T): T {
  const clone = structuredClone(value);
  return deepFreeze(clone);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

async function resolveReviewedFood(
  providers: MealPlanningProviders,
  name: string
): Promise<{ readonly resolution: FoodResolution; readonly snapshot: NutritionDataSnapshot }> {
  let resolution: FoodResolution | null;
  try {
    resolution = await providers.nutrition.resolveCanonicalName(name);
  } catch {
    throw new ProviderUnavailableError('nutrition_source_unavailable');
  }
  if (resolution === null) throw new ProviderUnavailableError('food_name_unresolved');

  try {
    const parsed = nutritionDataSnapshotSchema.parse(
      await providers.nutrition.getSnapshot(resolution.nutritionSnapshotId)
    );
    if (
      parsed.id !== resolution.nutritionSnapshotId
      || parsed.foodId !== resolution.foodId
      || !sourceAllowed(parsed, providers.allowTestFixtures)
    ) {
      throw new ProviderUnavailableError('nutrition_source_unavailable');
    }
    return {
      resolution: cloneAndFreeze({
        foodId: resolution.foodId,
        canonicalNameZh: resolution.canonicalNameZh,
        nutritionSnapshotId: resolution.nutritionSnapshotId
      }),
      snapshot: cloneAndFreeze(parsed)
    };
  } catch (error: unknown) {
    if (error instanceof ProviderUnavailableError) throw error;
    throw new ProviderUnavailableError('nutrition_source_unavailable');
  }
}

async function normalizeInventory(
  providers: MealPlanningProviders,
  items: readonly { readonly name: string; readonly availableGrams: number }[]
): Promise<readonly ResolvedInventoryItem[]> {
  const resolved: ResolvedInventoryItem[] = [];
  for (const item of items) {
    if (!Number.isFinite(item.availableGrams) || item.availableGrams <= 0) {
      throw new ProviderUnavailableError('food_name_unresolved');
    }
    const food = await resolveReviewedFood(providers, item.name);
    resolved.push({
      foodId: food.resolution.foodId,
      nutritionSnapshotId: food.resolution.nutritionSnapshotId,
      availableGrams: item.availableGrams
    });
  }

  const merged = new Map<string, ResolvedInventoryItem>();
  for (const item of resolved) {
    const previous = merged.get(item.foodId);
    if (previous !== undefined && previous.nutritionSnapshotId !== item.nutritionSnapshotId) {
      throw new ProviderUnavailableError('nutrition_source_unavailable');
    }
    merged.set(item.foodId, {
      foodId: item.foodId,
      nutritionSnapshotId: item.nutritionSnapshotId,
      availableGrams: (previous?.availableGrams ?? 0) + item.availableGrams
    });
  }
  return [...merged.values()].sort((left, right) => left.foodId.localeCompare(right.foodId));
}

export function targetsForActiveWeek(
  state: PlanningAggregateState,
  bodyProfile: BodyProfileVersion,
  goal: GoalVersion,
  trainingPlan: TrainingPlanVersion
): readonly DailyNutritionTargetVersion[] {
  const relatedPlanIds = new Set(
    state.trainingPlans.filter((candidate) => (
      candidate.bodyProfileVersionId === bodyProfile.id
      && candidate.goalVersionId === goal.id
      && candidate.payload.weekStartDate === trainingPlan.payload.weekStartDate
    )).map((candidate) => candidate.id)
  );
  const latestByDate = new Map<string, DailyNutritionTargetVersion>();
  for (const target of state.dailyNutritionTargets) {
    if (
      target.bodyProfileVersionId !== bodyProfile.id
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

export function generationPrerequisites(
  state: PlanningAggregateState,
  weekStartDate: string
): GenerationPrerequisites {
  const bodyProfile = findById(state.bodyProfiles, state.activeBodyProfileVersionId);
  if (bodyProfile === null) throw new PlanningPrerequisiteError('body_profile');
  const goal = findById(state.goals, state.activeGoalVersionId);
  if (goal === null || goal.bodyProfileVersionId !== bodyProfile.id) {
    throw new PlanningPrerequisiteError('goal');
  }
  const trainingPlan = findById(state.trainingPlans, state.activeTrainingPlanVersionId);
  if (
    trainingPlan === null
    || trainingPlan.bodyProfileVersionId !== bodyProfile.id
    || trainingPlan.goalVersionId !== goal.id
    || trainingPlan.payload.weekStartDate !== weekStartDate
  ) throw new PlanningPrerequisiteError('training_plan');
  const inventory = findById(state.inventories, state.activeInventoryVersionId);
  if (inventory === null) throw new PlanningPrerequisiteError('inventory');
  const targets = targetsForActiveWeek(state, bodyProfile, goal, trainingPlan);
  if (
    targets.length !== 7
    || targets.some((target) => (
      target.energy.kind !== 'supported'
      || target.nutrition === null
      || target.nutrition.kind !== 'feasible'
    ))
  ) {
    throw new NutritionConstraintsInfeasibleError([{
      businessDate: weekStartDate,
      code: 'target_nutrition_infeasible'
    }]);
  }
  return {
    bodyProfile,
    goal,
    trainingPlan,
    inventory,
    targets,
    compareToken: {
      bodyProfileVersionId: bodyProfile.id,
      goalVersionId: goal.id,
      trainingPlanVersionId: trainingPlan.id,
      inventoryVersionId: inventory.id,
      dailyNutritionTargetVersionIds: targets.map((target) => target.id)
    }
  };
}

export async function loadProviderSnapshot(
  providers: MealPlanningProviders
): Promise<ProviderSnapshot> {
  try {
    const catalog = dailyMenuCatalogVersionSchema.parse(
      await providers.menus.getActiveCatalog()
    );
    if (!sourceAllowed(catalog, providers.allowTestFixtures)) {
      throw new ProviderUnavailableError('meal_catalog_unavailable');
    }
    const menuIds = [...new Set(catalog.dailyMenuTemplateVersionIds)].sort();
    const menus: DailyMenuTemplateVersion[] = [];
    for (const id of menuIds) {
      const menu = dailyMenuTemplateVersionSchema.parse(
        await providers.menus.getMenuByVersionId(id)
      );
      if (menu.id !== id || !sourceAllowed(menu, providers.allowTestFixtures)) {
        throw new ProviderUnavailableError('meal_catalog_unavailable');
      }
      menus.push(menu);
    }
    const recipeIds = [...new Set(
      menus.flatMap((menu) => menu.meals.map((meal) => meal.recipeTemplateVersionId))
    )].sort();
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
    const snapshotIds = [...new Set(
      recipes.flatMap((recipe) => recipe.ingredients.map((item) => item.nutritionSnapshotId))
    )].sort();
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
    return cloneAndFreeze({ catalog, menus, recipes, snapshots });
  } catch (error: unknown) {
    if (error instanceof ProviderUnavailableError) throw error;
    throw new ProviderUnavailableError('meal_catalog_unavailable');
  }
}

export function mealGenerationTokensEqual(
  left: MealGenerationCompareToken,
  right: MealGenerationCompareToken
): boolean {
  return left.bodyProfileVersionId === right.bodyProfileVersionId
    && left.goalVersionId === right.goalVersionId
    && left.trainingPlanVersionId === right.trainingPlanVersionId
    && left.inventoryVersionId === right.inventoryVersionId
    && left.dailyNutritionTargetVersionIds.length === right.dailyNutritionTargetVersionIds.length
    && left.dailyNutritionTargetVersionIds.every((id, index) => (
      id === right.dailyNutritionTargetVersionIds[index]
    ));
}

export function createMealPlanGenerationService(
  dependencies: MealPlanGenerationServiceDependencies
) {
  const { repository, providers, now, nextId } = dependencies;
  const base = createVersionedPlanningService(dependencies);

  return {
    ...base,

    async resolveFoodName(name: string): Promise<FoodResolution | null> {
      try {
        return (await resolveReviewedFood(providers, name)).resolution;
      } catch (error: unknown) {
        if (error instanceof ProviderUnavailableError && error.reason === 'food_name_unresolved') {
          return null;
        }
        throw error;
      }
    },

    async saveInventory(
      userId: string,
      envelope: WriteCommandEnvelope<{
        readonly items: readonly { readonly name: string; readonly availableGrams: number }[];
      }>
    ): Promise<InventoryVersion> {
      const expectedFingerprint = inventoryRequestFingerprint(envelope);
      const initialState = await repository.read(userId);
      const initialReplay = findRecord(initialState, 'saveInventory', envelope.idempotencyKey);
      if (initialReplay !== undefined) {
        assertReplay(initialReplay, expectedFingerprint, envelope.idempotencyKey);
        const previous = findById(initialState.inventories, initialReplay.resultVersionId);
        if (previous === null) throw new Error('Stored idempotency result is missing');
        return previous;
      }
      const items = await normalizeInventory(providers, envelope.payload.items);
      return repository.transact(userId, (state) => {
        const replay = findRecord(state, 'saveInventory', envelope.idempotencyKey);
        if (replay !== undefined) {
          assertReplay(replay, expectedFingerprint, envelope.idempotencyKey);
          const previous = findById(state.inventories, replay.resultVersionId);
          if (previous === null) throw new Error('Stored idempotency result is missing');
          return { nextState: state, result: previous };
        }
        if (envelope.expectedVersion !== state.inventories.length) {
          throw new VersionConflictError(envelope.expectedVersion, state.inventories.length);
        }
        const inventory: InventoryVersion = {
          kind: 'inventory_version',
          id: nextId('inventory'),
          userId,
          version: state.inventories.length + 1,
          createdAt: now(),
          items
        };
        const record: IdempotencyRecord = {
          operation: 'saveInventory',
          key: envelope.idempotencyKey,
          requestFingerprint: expectedFingerprint,
          resultVersionId: inventory.id
        };
        return {
          nextState: {
            ...state,
            inventories: [...state.inventories, inventory],
            activeInventoryVersionId: inventory.id,
            idempotencyRecords: [...state.idempotencyRecords, record]
          },
          result: inventory
        };
      });
    },

    async generateWeeklyMealPlan(
      userId: string,
      envelope: WriteCommandEnvelope<{ readonly weekStartDate: string }>
    ): Promise<MealPlanVersion> {
      const expectedFingerprint = requestFingerprint({
        expectedVersion: envelope.expectedVersion,
        payload: envelope.payload
      });
      const initialState = await repository.read(userId);
      const initialReplay = findRecord(
        initialState,
        'generateWeeklyMealPlan',
        envelope.idempotencyKey
      );
      if (initialReplay !== undefined) {
        assertReplay(initialReplay, expectedFingerprint, envelope.idempotencyKey);
        const previous = findById(initialState.mealPlans, initialReplay.resultVersionId);
        if (previous === null) throw new Error('Stored idempotency result is missing');
        return previous;
      }
      if (envelope.expectedVersion !== initialState.mealPlans.length) {
        throw new VersionConflictError(envelope.expectedVersion, initialState.mealPlans.length);
      }
      const prerequisites = generationPrerequisites(initialState, envelope.payload.weekStartDate);
      const providerSnapshot = await loadProviderSnapshot(providers);
      const generated = generateDeterministicWeeklyMealPlan({
        weekStartDate: envelope.payload.weekStartDate,
        targets: prerequisites.targets,
        inventory: prerequisites.inventory.items,
        allergens: prerequisites.bodyProfile.payload.allergens,
        avoidFoodIds: prerequisites.bodyProfile.payload.avoidFoods,
        catalog: providerSnapshot.catalog,
        menus: providerSnapshot.menus,
        recipes: providerSnapshot.recipes,
        snapshots: providerSnapshot.snapshots,
        allowTestFixtures: providers.allowTestFixtures,
        fixedDays: []
      });
      if (generated.kind === 'infeasible') {
        throw new NutritionConstraintsInfeasibleError(
          withReviewedFoodNames(generated.conflicts, providerSnapshot.snapshots)
        );
      }
      const initialProviderSnapshotToken = providerSnapshotToken(providerSnapshot);
      const commitProviderSnapshotToken = providerSnapshotToken(
        await loadProviderSnapshot(providers)
      );
      if (commitProviderSnapshotToken !== initialProviderSnapshotToken) {
        throw new VersionConflictError(envelope.expectedVersion, initialState.mealPlans.length);
      }

      return repository.transact(userId, (state) => {
        const replay = findRecord(state, 'generateWeeklyMealPlan', envelope.idempotencyKey);
        if (replay !== undefined) {
          assertReplay(replay, expectedFingerprint, envelope.idempotencyKey);
          const previous = findById(state.mealPlans, replay.resultVersionId);
          if (previous === null) throw new Error('Stored idempotency result is missing');
          return { nextState: state, result: previous };
        }
        if (envelope.expectedVersion !== state.mealPlans.length) {
          throw new VersionConflictError(envelope.expectedVersion, state.mealPlans.length);
        }
        const current = generationPrerequisites(state, envelope.payload.weekStartDate);
        if (!mealGenerationTokensEqual(prerequisites.compareToken, current.compareToken)) {
          throw new VersionConflictError(envelope.expectedVersion, state.mealPlans.length);
        }
        const mealPlan: MealPlanVersion = {
          kind: 'meal_plan_version',
          id: nextId('meal-plan'),
          userId,
          version: state.mealPlans.length + 1,
          createdAt: now(),
          weekStartDate: envelope.payload.weekStartDate,
          bodyProfileVersionId: current.bodyProfile.id,
          goalVersionId: current.goal.id,
          trainingPlanVersionId: current.trainingPlan.id,
          inventoryVersionId: current.inventory.id,
          catalogVersionId: generated.catalogVersionId,
          generationPolicyVersion: generated.policyVersion,
          supersedesVersionId: state.activeMealPlanVersionId,
          readiness: 'complete',
          days: generated.days
        };
        const record: IdempotencyRecord = {
          operation: 'generateWeeklyMealPlan',
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
