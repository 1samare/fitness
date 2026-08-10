import type {
  DailyEnergyResult,
  FitnessGoal,
  NonTrainingActivity,
  SexCode
} from './daily-energy';
import type { NutritionTargetResult } from './nutrition-target';

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
  readonly energy: DailyEnergyResult;
  readonly nutrition: NutritionTargetResult | null;
}

export interface LatestPlanningVersions {
  readonly bodyProfile: number;
  readonly goal: number;
  readonly trainingPlan: number;
}

export interface CompletePlanningSetupCommand {
  readonly expectedVersions: LatestPlanningVersions;
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
  | 'completePlanningSetup';

export type IdempotencyRecord =
  | {
      readonly operation: 'saveBodyProfile';
      readonly key: string;
      readonly requestFingerprint: string;
      readonly resultVersionId: string;
    }
  | {
      readonly operation: 'saveGoal';
      readonly key: string;
      readonly requestFingerprint: string;
      readonly resultVersionId: string;
    }
  | {
      readonly operation: 'saveTrainingPlan';
      readonly key: string;
      readonly requestFingerprint: string;
      readonly resultVersionId: string;
    }
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
  readonly bodyProfiles: readonly BodyProfileVersion[];
  readonly goals: readonly GoalVersion[];
  readonly trainingPlans: readonly TrainingPlanVersion[];
  readonly dailyEnergyTargets: readonly DailyEnergyTargetVersion[];
  readonly dailyNutritionTargets: readonly DailyNutritionTargetVersion[];
  readonly outboxEvents: readonly TrainingPlanChangedEvent[];
  readonly idempotencyRecords: readonly IdempotencyRecord[];
  readonly activeBodyProfileVersionId: string | null;
  readonly activeGoalVersionId: string | null;
  readonly activeTrainingPlanVersionId: string | null;
}

export interface CurrentPlanningContext {
  readonly bodyProfile: BodyProfileVersion | null;
  readonly goal: GoalVersion | null;
  readonly trainingPlan: TrainingPlanVersion | null;
  readonly dailyEnergyTargets: readonly DailyEnergyTargetVersion[];
  readonly dailyNutritionTargets: readonly DailyNutritionTargetVersion[];
  readonly latestVersions: LatestPlanningVersions;
}

export interface WriteCommandEnvelope<TPayload> {
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly payload: TPayload;
}
