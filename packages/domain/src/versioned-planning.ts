import type {
  DailyEnergyResult,
  FitnessGoal,
  NonTrainingActivity,
  SexCode
} from './daily-energy';
import type { NutritionTargetResult } from './nutrition-target';
import type { IngredientPhotoVersion } from './ingredient-photo';
import type {
  InventoryVersion,
  MealPlanDecision,
  MealPlanTargetDiff,
  MealPlanVersion,
  RecalculationJob,
  TrainingCompletionEvent
} from './meal-planning';
import type { AssistantConversationState } from './assistant-conversation';

export interface BodyProfilePayload {
  readonly ageYears: number;
  readonly sexCode: SexCode;
  readonly heightCm: number;
  readonly weightKg: number;
  readonly healthScopeConfirmed: boolean;
  readonly nonTrainingActivity: NonTrainingActivity;
  readonly allergens: readonly string[];
  readonly avoidFoods: readonly string[];
  readonly dietPreferences: readonly string[];
  readonly businessTimezone: string;
}

export interface GoalPayload {
  readonly goal: FitnessGoal;
  readonly targetWeightKg?: number | undefined;
  readonly effectiveDate: string;
  readonly targetDate: string;
}

export interface TrainingSessionPayload {
  readonly businessDate: string;
  readonly sessionCode: string;
  readonly durationMinutes: number;
}

export interface TrainingPlanPayload {
  readonly weekStartDate: string;
  readonly businessTimezone: string;
  readonly sessions: readonly TrainingSessionPayload[];
}

interface VersionMetadata {
  readonly id: string;
  readonly userId: string;
  readonly version: number;
  readonly createdAt: string;
}

export interface BodyProfileVersion extends VersionMetadata {
  readonly kind: 'body_profile_version';
  readonly payload: BodyProfilePayload;
}

export interface GoalVersion extends VersionMetadata {
  readonly kind: 'goal_version';
  readonly bodyProfileVersionId: string;
  readonly payload: GoalPayload;
}

export interface TrainingPlanVersion extends VersionMetadata {
  readonly kind: 'training_plan_version';
  readonly bodyProfileVersionId: string;
  readonly goalVersionId: string;
  readonly payload: TrainingPlanPayload;
}

export interface DailyEnergyTargetVersion extends VersionMetadata {
  readonly kind: 'daily_energy_target_version';
  readonly businessDate: string;
  readonly bodyProfileVersionId: string;
  readonly goalVersionId: string;
  readonly trainingPlanVersionId: string;
  readonly energyPolicyVersion: 'calculation-policy-v2';
  readonly nutritionPolicyVersion: 'nutrition-policy-v1';
  readonly trainingCompletionEventId?: string | undefined;
  readonly energy: DailyEnergyResult;
}

export interface DailyNutritionTargetVersion extends VersionMetadata {
  readonly kind: 'daily_nutrition_target_version';
  readonly businessDate: string;
  readonly bodyProfileVersionId: string;
  readonly goalVersionId: string;
  readonly trainingPlanVersionId: string;
  readonly dailyEnergyTargetVersionId: string;
  readonly energyPolicyVersion: 'calculation-policy-v2';
  readonly nutritionPolicyVersion: 'nutrition-policy-v1';
  readonly trainingCompletionEventId?: string | undefined;
  readonly energy: DailyEnergyResult;
  readonly nutrition: NutritionTargetResult | null;
}

export interface LatestPlanningVersions {
  readonly bodyProfile: number;
  readonly goal: number;
  readonly trainingPlan: number;
  readonly inventory: number;
  readonly mealPlan: number;
  readonly mealPlanDecision: number;
  readonly trainingCompletion: number;
  readonly recalculationJob: number;
  readonly ingredientPhoto: number;
}

export interface CompletePlanningSetupCommand {
  readonly expectedVersions: Pick<
    LatestPlanningVersions,
    'bodyProfile' | 'goal' | 'trainingPlan'
  >;
  readonly idempotencyKey: string;
  readonly bodyProfile: BodyProfilePayload;
  readonly goal: GoalPayload;
  readonly trainingPlan: TrainingPlanPayload;
}

export interface TrainingPlanChangedEvent {
  readonly eventId: string;
  readonly eventType: 'TrainingPlanChanged';
  readonly userId: string;
  readonly previousTrainingPlanVersionId: string | null;
  readonly trainingPlanVersionId: string;
  readonly bodyProfileVersionId: string;
  readonly goalVersionId: string;
  readonly affectedDates: readonly string[];
  readonly occurredAt: string;
  readonly status: 'pending';
}

export type PlanningWriteOperation =
  | 'saveBodyProfile'
  | 'saveGoal'
  | 'saveTrainingPlan'
  | 'completePlanningSetup'
  | 'saveInventory'
  | 'generateWeeklyMealPlan'
  | 'setMealPlanDayLock'
  | 'updateMealPlanDay'
  | 'resizeMealPlanPortion'
  | 'recordTrainingCompletion'
  | 'decideMealPlanCandidate'
  | 'retryPendingRecalculation'
  | 'createIngredientPhotoUpload'
  | 'registerIngredientPhotoUpload'
  | 'recognizeIngredientPhoto'
  | 'confirmIngredientCandidate'
  | 'cleanupIngredientPhoto';

type SingleResultIdempotencyRecord<TOperation extends PlanningWriteOperation> = {
  readonly operation: TOperation;
  readonly key: string;
  readonly requestFingerprint: string;
  readonly resultVersionId: string;
};

export type IdempotencyRecord =
  | SingleResultIdempotencyRecord<'saveBodyProfile'>
  | SingleResultIdempotencyRecord<'saveGoal'>
  | SingleResultIdempotencyRecord<'saveTrainingPlan'>
  | SingleResultIdempotencyRecord<'saveInventory'>
  | SingleResultIdempotencyRecord<'generateWeeklyMealPlan'>
  | SingleResultIdempotencyRecord<'setMealPlanDayLock'>
  | SingleResultIdempotencyRecord<'updateMealPlanDay'>
  | SingleResultIdempotencyRecord<'resizeMealPlanPortion'>
  | SingleResultIdempotencyRecord<'recordTrainingCompletion'>
  | SingleResultIdempotencyRecord<'decideMealPlanCandidate'>
  | SingleResultIdempotencyRecord<'retryPendingRecalculation'>
  | SingleResultIdempotencyRecord<'createIngredientPhotoUpload'>
  | SingleResultIdempotencyRecord<'registerIngredientPhotoUpload'>
  | SingleResultIdempotencyRecord<'recognizeIngredientPhoto'>
  | SingleResultIdempotencyRecord<'confirmIngredientCandidate'>
  | SingleResultIdempotencyRecord<'cleanupIngredientPhoto'>
  | {
      readonly operation: 'completePlanningSetup';
      readonly key: string;
      readonly requestFingerprint: string;
      readonly resultVersionIds: {
        readonly bodyProfileVersionId: string;
        readonly goalVersionId: string;
        readonly trainingPlanVersionId: string;
        readonly dailyEnergyTargetVersionIds: readonly string[];
        readonly eventId: string;
      };
    };

export interface PlanningAggregateState {
  readonly assistantConversation: AssistantConversationState;
  readonly bodyProfiles: readonly BodyProfileVersion[];
  readonly goals: readonly GoalVersion[];
  readonly trainingPlans: readonly TrainingPlanVersion[];
  readonly dailyEnergyTargets: readonly DailyEnergyTargetVersion[];
  readonly dailyNutritionTargets: readonly DailyNutritionTargetVersion[];
  readonly inventories: readonly InventoryVersion[];
  readonly mealPlans: readonly MealPlanVersion[];
  readonly mealPlanTargetDiffs: readonly MealPlanTargetDiff[];
  readonly mealPlanDecisions: readonly MealPlanDecision[];
  readonly trainingCompletionEvents: readonly TrainingCompletionEvent[];
  readonly recalculationJobs: readonly RecalculationJob[];
  readonly ingredientPhotoVersions: readonly IngredientPhotoVersion[];
  readonly outboxEvents: readonly TrainingPlanChangedEvent[];
  readonly idempotencyRecords: readonly IdempotencyRecord[];
  readonly activeBodyProfileVersionId: string | null;
  readonly activeGoalVersionId: string | null;
  readonly activeTrainingPlanVersionId: string | null;
  readonly activeInventoryVersionId: string | null;
  readonly activeMealPlanVersionId: string | null;
  readonly nextPhotoCleanupAt: string | null;
}

export interface CurrentPlanningContext {
  readonly bodyProfile: BodyProfileVersion | null;
  readonly goal: GoalVersion | null;
  readonly trainingPlan: TrainingPlanVersion | null;
  readonly dailyEnergyTargets: readonly DailyEnergyTargetVersion[];
  readonly dailyNutritionTargets: readonly DailyNutritionTargetVersion[];
  readonly inventory: InventoryVersion | null;
  readonly mealPlan: MealPlanVersion | null;
  readonly mealPlanStale: boolean;
  readonly pendingMealPlanCandidate: MealPlanVersion | null;
  readonly pendingMealPlanTargetDiffs: readonly MealPlanTargetDiff[];
  readonly selectableRecipes: readonly {
    readonly recipeTemplateVersionId: string;
    readonly dishNameZh: string;
  }[];
  readonly selectableRecipesStatus: 'available' | 'no_options' | 'provider_unavailable';
  readonly retryableRecalculationJob: RecalculationJob | null;
  readonly ingredientPhoto: IngredientPhotoVersion | null;
  readonly latestVersions: LatestPlanningVersions;
}

export interface WriteCommandEnvelope<TPayload> {
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly payload: TPayload;
}
