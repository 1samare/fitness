import type { FitnessGoal, SexCode } from './daily-energy';

export type TrainingKind = 'none' | 'general_or_endurance' | 'regular_resistance';

export interface NutritionTargetInput {
  readonly targetEnergyKcal: number;
  readonly weightKg: number;
  readonly sexCode: SexCode;
  readonly goal: FitnessGoal;
  readonly trainingKind: TrainingKind;
}

export interface NutritionPolicyMetadata {
  readonly policyVersion: 'nutrition-policy-v1';
  readonly sourceIds: readonly [
    'CN-DRI-MACRO-2017',
    'PROTEIN-MORTON-2018',
    'ISSN-PROTEIN-2017'
  ];
  readonly applicableAgeRange: {
    readonly minInclusive: 18;
    readonly maxInclusive: 45;
  };
  readonly applicableBmiRange: {
    readonly minInclusive: 18.5;
    readonly maxExclusive: 24;
  };
  readonly effectiveDate: string;
  readonly reviewedAt: string;
  readonly protein: {
    readonly noTrainingRniG: { readonly male: 65; readonly female: 55 };
    readonly generalOrEndurancePerKg: 1.4;
    readonly resistanceOrMuscleGainPerKg: 1.6;
    readonly automaticMaxPerKg: 2;
  };
  readonly fatEnergyRange: {
    readonly minInclusive: 0.2;
    readonly midpoint: 0.25;
    readonly maxInclusive: 0.3;
  };
  readonly carbohydrateEnergyRange: {
    readonly minInclusive: 0.5;
    readonly maxInclusive: 0.65;
  };
  readonly carbohydrateMinimumG: 120;
  readonly fiberRangeG: { readonly minInclusive: 25; readonly maxInclusive: 30 };
  readonly saturatedFatEnergyMaxExclusive: 0.1;
  readonly addedSugarEnergyMaxExclusive: 0.1;
  readonly kcalPerGram: { readonly protein: 4; readonly carbohydrate: 4; readonly fat: 9 };
  readonly rounding: {
    readonly grams: 'nearest_tenth_half_up';
    readonly percentage: 'nearest_tenth_half_up';
  };
}

export type NutritionConstraintConflict =
  | {
      readonly code: 'protein_automatic_max_exceeded';
      readonly proteinG: number;
      readonly maximumG: number;
    }
  | {
      readonly code: 'carbohydrate_minimum_exceeds_share_maximum';
      readonly minimumG: 120;
      readonly maximumByEnergyG: number;
    }
  | {
      readonly code: 'macro_energy_intersection_empty';
      readonly minimumCarbohydrateKcal: number;
      readonly maximumCarbohydrateKcal: number;
    };

export type NutritionTargetResult =
  | {
      readonly kind: 'feasible';
      readonly targetEnergyKcal: number;
      readonly proteinG: number;
      readonly fatG: number;
      readonly carbohydrateG: number;
      readonly proteinEnergyPercent: number;
      readonly fatEnergyPercent: number;
      readonly carbohydrateEnergyPercent: number;
      readonly fiberRangeG: { readonly minInclusive: 25; readonly maxInclusive: 30 };
      readonly saturatedFatMaxExclusiveG: number;
      readonly addedSugarMaxExclusiveG: number;
      readonly policy: NutritionPolicyMetadata;
    }
  | {
      readonly kind: 'infeasible';
      readonly code: 'nutrition_constraints_infeasible';
      readonly conflicts: readonly NutritionConstraintConflict[];
      readonly targetEnergyKcal: number;
      readonly policy: NutritionPolicyMetadata;
    };
