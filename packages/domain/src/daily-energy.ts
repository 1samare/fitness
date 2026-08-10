export type SexCode = 0 | 1;
export type NonTrainingActivity = 'light' | 'moderate' | 'heavy';
export type FitnessGoal = 'maintain' | 'fat_loss' | 'muscle_gain';
export type UnsupportedReason =
  | 'age_out_of_range'
  | 'bmi_out_of_range'
  | 'health_scope_not_confirmed';

export interface EligibilityInput {
  readonly ageYears: number;
  readonly heightCm: number;
  readonly weightKg: number;
  readonly healthScopeConfirmed: boolean;
}

export interface ReviewedTrainingSession {
  readonly code: string;
  readonly met: number;
  readonly sourceId: 'MET-COMPENDIUM-2024';
  readonly originalUnit: 'MET';
  readonly activityCategory: 'conditioning_exercise';
  readonly trainingKind: 'regular_resistance';
  readonly datasetVersion: string;
  readonly reviewedAt: string;
  readonly description: string;
}

export interface DailyEnergyCommand extends EligibilityInput {
  readonly sexCode: SexCode;
  readonly nonTrainingActivity: NonTrainingActivity;
  readonly goal: FitnessGoal;
  readonly training?: {
    readonly session: ReviewedTrainingSession;
    readonly durationMinutes: number;
  };
}

export interface PolicyMetadata {
  readonly policyVersion: 'calculation-policy-v2';
  readonly sourceIds: string[];
  readonly applicableAgeRange: { readonly minInclusive: 18; readonly maxInclusive: 45 };
  readonly applicableBmiRange: { readonly minInclusive: 18.5; readonly maxExclusive: 24 };
  readonly rounding: {
    readonly kcal: 'nearest_whole_half_up';
    readonly bmi: 'nearest_hundredth_half_up';
  };
}

export type DailyEnergyResult =
  | {
      readonly kind: 'supported';
      readonly bmi: number;
      readonly estimatedBmrKcal: number;
      readonly nonTrainingBaselineKcal: number;
      readonly trainingNetKcal: number;
      readonly estimatedMaintenanceKcal: number;
      readonly targetEnergyKcal: number;
      readonly policy: PolicyMetadata;
      readonly disclaimer: string;
    }
  | {
      readonly kind: 'unsupported';
      readonly code: 'unsupported_for_personalized_energy';
      readonly reasons: UnsupportedReason[];
      readonly bmi: number;
      readonly policy: PolicyMetadata;
    };
