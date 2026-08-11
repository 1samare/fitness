import type { NutrientValues } from './food-nutrition';

export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export interface DailyMenuTemplateVersion {
  readonly id: string;
  readonly datasetVersion: string;
  readonly sourceId: string;
  readonly reviewedAt: string;
  readonly qualityStatus: 'reviewed' | 'test_fixture';
  readonly meals: readonly {
    readonly slot: MealSlot;
    readonly recipeTemplateVersionId: string;
  }[];
}

export interface DailyMenuCatalogVersion {
  readonly id: string;
  readonly datasetVersion: string;
  readonly sourceId: string;
  readonly reviewedAt: string;
  readonly qualityStatus: 'reviewed' | 'test_fixture';
  readonly dailyMenuTemplateVersionIds: readonly string[];
}

export interface DailyMenuCatalogProvider {
  getActiveCatalog(): Promise<DailyMenuCatalogVersion>;
  getMenuByVersionId(versionId: string): Promise<DailyMenuTemplateVersion>;
}

export interface InventoryVersion {
  readonly kind: 'inventory_version';
  readonly id: string;
  readonly userId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly items: readonly {
    readonly foodId: string;
    readonly nutritionSnapshotId: string;
    readonly availableGrams: number;
  }[];
}

export interface MealAssignment {
  readonly slot: MealSlot;
  readonly recipeTemplateVersionId: string;
  readonly servingMultiplier: number;
  /** Reviewed display snapshot persisted with the plan; never derived from an internal id. */
  readonly dishNameZh?: string | undefined;
  readonly ingredients?: readonly MealIngredientDisplay[] | undefined;
}

export interface MealIngredientDisplay {
  readonly displayNameZh: string;
  readonly grams: number;
}

export interface MealDisplaySnapshot {
  readonly slot: MealSlot;
  readonly dishNameZh: string;
  readonly ingredients: readonly MealIngredientDisplay[];
}

export interface MealTargetDisplaySnapshot {
  readonly estimatedEnergyKcal: number;
  readonly proteinG: number;
  readonly fatG: number;
  readonly carbohydrateG: number;
  readonly fiberRangeG: { readonly minInclusive: number; readonly maxInclusive: number };
}

export interface MealPlanDay {
  readonly businessDate: string;
  readonly dailyNutritionTargetVersionId: string;
  readonly dailyMenuTemplateVersionId: string;
  readonly locked: boolean;
  readonly manuallyModified: boolean;
  readonly meals: readonly MealAssignment[];
  readonly ingredientAmounts: readonly { readonly foodId: string; readonly grams: number }[];
  readonly nutritionTotals: NutrientValues;
  readonly nutritionSourceSnapshotIds: readonly string[];
}

export interface MealPlanVersion {
  readonly kind: 'meal_plan_version';
  readonly id: string;
  readonly userId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly weekStartDate: string;
  readonly bodyProfileVersionId: string;
  readonly goalVersionId: string;
  readonly trainingPlanVersionId: string;
  readonly inventoryVersionId: string;
  readonly catalogVersionId: string;
  readonly generationPolicyVersion: 'weekly-meal-generation-v1';
  readonly supersedesVersionId: string | null;
  readonly readiness: 'complete' | 'pending_confirmation';
  readonly days: readonly MealPlanDay[];
}

export interface MealPlanTargetDiff {
  readonly id: string;
  readonly userId: string;
  readonly candidateMealPlanVersionId: string;
  readonly businessDate: string;
  readonly previousNutritionTargetVersionId: string;
  readonly proposedNutritionTargetVersionId: string;
  readonly reason: 'locked_or_manually_modified';
  readonly previousTarget?: MealTargetDisplaySnapshot | undefined;
  readonly proposedTarget?: MealTargetDisplaySnapshot | undefined;
  readonly previousMeals?: readonly MealDisplaySnapshot[] | undefined;
  readonly proposedMeals?: readonly MealDisplaySnapshot[] | undefined;
}

export interface MealPlanDecision {
  readonly kind: 'meal_plan_decision';
  readonly id: string;
  readonly userId: string;
  readonly version: number;
  readonly candidateMealPlanVersionId: string;
  readonly previousActiveMealPlanVersionId: string;
  readonly decision: 'keep_existing' | 'overwrite_locked';
  readonly decidedAt: string;
  readonly activatedMealPlanVersionId: string | null;
}

export interface TrainingCompletionEvent {
  readonly kind: 'training_completion_event';
  readonly id: string;
  readonly userId: string;
  readonly version: number;
  readonly trainingPlanVersionId: string;
  readonly businessDate: string;
  readonly completedDurationMinutes: number;
  readonly occurredAt: string;
}

export interface RecalculationJob {
  readonly kind: 'recalculation_job';
  readonly id: string;
  readonly userId: string;
  readonly triggerEventId: string;
  readonly triggerType: 'training_plan_changed' | 'training_completion';
  readonly affectedDates: readonly string[];
  readonly status: 'pending' | 'completed' | 'failed_retryable';
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly candidateMealPlanVersionId: string | null;
  readonly activatedMealPlanVersionId: string | null;
  readonly failureCode: 'provider_unavailable' | 'nutrition_constraints_infeasible' | null;
}
