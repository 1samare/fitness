import type {
  NutritionConstraintConflict,
  NutritionTargetInput,
  NutritionTargetResult
} from '@fitness/domain';
import { NUTRITION_POLICY_V1 } from './nutrition-policy';
import { roundHalfUp } from './rounding';

function infeasible(
  targetEnergyKcal: number,
  conflicts: readonly NutritionConstraintConflict[]
): NutritionTargetResult {
  return {
    kind: 'infeasible',
    code: 'nutrition_constraints_infeasible',
    conflicts,
    targetEnergyKcal,
    policy: NUTRITION_POLICY_V1
  };
}

function proteinTargetG(input: NutritionTargetInput): number {
  const protein = NUTRITION_POLICY_V1.protein;
  if (input.goal === 'muscle_gain' || input.trainingKind === 'regular_resistance') {
    return input.weightKg * protein.resistanceOrMuscleGainPerKg;
  }
  if (input.trainingKind === 'general_or_endurance') {
    return input.weightKg * protein.generalOrEndurancePerKg;
  }
  return input.sexCode === 0
    ? protein.noTrainingRniG.male
    : protein.noTrainingRniG.female;
}

function exclusiveUpperBoundToTenths(value: number): number {
  return (Math.ceil(value * 10) - 1) / 10;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function calculateNutritionTargets(
  input: NutritionTargetInput
): NutritionTargetResult {
  const policy = NUTRITION_POLICY_V1;
  const proteinG = roundHalfUp(proteinTargetG(input), 1);
  const maximumProteinG = input.weightKg * policy.protein.automaticMaxPerKg;
  if (proteinG > maximumProteinG) {
    return infeasible(input.targetEnergyKcal, [{
      code: 'protein_automatic_max_exceeded',
      proteinG,
      maximumG: roundHalfUp(maximumProteinG, 1)
    }]);
  }

  const conflicts: NutritionConstraintConflict[] = [];
  const maximumCarbohydrateByEnergyG = input.targetEnergyKcal
    * policy.carbohydrateEnergyRange.maxInclusive
    / policy.kcalPerGram.carbohydrate;
  if (policy.carbohydrateMinimumG > maximumCarbohydrateByEnergyG) {
    conflicts.push({
      code: 'carbohydrate_minimum_exceeds_share_maximum',
      minimumG: policy.carbohydrateMinimumG,
      maximumByEnergyG: roundHalfUp(maximumCarbohydrateByEnergyG, 1)
    });
  }

  const proteinKcal = proteinG * policy.kcalPerGram.protein;
  const macroRemainderKcal = input.targetEnergyKcal - proteinKcal;
  const carbohydrateMinimumKcal = Math.max(
    input.targetEnergyKcal * policy.carbohydrateEnergyRange.minInclusive,
    policy.carbohydrateMinimumG * policy.kcalPerGram.carbohydrate
  );
  const carbohydrateMaximumKcal = input.targetEnergyKcal
    * policy.carbohydrateEnergyRange.maxInclusive;
  const fatMinimumKcal = input.targetEnergyKcal * policy.fatEnergyRange.minInclusive;
  const fatMaximumKcal = input.targetEnergyKcal * policy.fatEnergyRange.maxInclusive;
  const feasibleCarbohydrateMinimumKcal = Math.max(
    carbohydrateMinimumKcal,
    macroRemainderKcal - fatMaximumKcal
  );
  const feasibleCarbohydrateMaximumKcal = Math.min(
    carbohydrateMaximumKcal,
    macroRemainderKcal - fatMinimumKcal
  );

  if (feasibleCarbohydrateMinimumKcal > feasibleCarbohydrateMaximumKcal) {
    conflicts.push({
      code: 'macro_energy_intersection_empty',
      minimumCarbohydrateKcal: roundHalfUp(feasibleCarbohydrateMinimumKcal, 1),
      maximumCarbohydrateKcal: roundHalfUp(feasibleCarbohydrateMaximumKcal, 1)
    });
  }
  if (conflicts.length > 0) return infeasible(input.targetEnergyKcal, conflicts);

  const preferredCarbohydrateKcal = macroRemainderKcal
    - input.targetEnergyKcal * policy.fatEnergyRange.midpoint;
  const carbohydrateKcal = clamp(
    preferredCarbohydrateKcal,
    feasibleCarbohydrateMinimumKcal,
    feasibleCarbohydrateMaximumKcal
  );
  const fatKcal = macroRemainderKcal - carbohydrateKcal;

  return {
    kind: 'feasible',
    targetEnergyKcal: input.targetEnergyKcal,
    proteinG,
    fatG: roundHalfUp(fatKcal / policy.kcalPerGram.fat, 1),
    carbohydrateG: roundHalfUp(
      carbohydrateKcal / policy.kcalPerGram.carbohydrate,
      1
    ),
    proteinEnergyPercent: roundHalfUp((proteinKcal / input.targetEnergyKcal) * 100, 1),
    fatEnergyPercent: roundHalfUp((fatKcal / input.targetEnergyKcal) * 100, 1),
    carbohydrateEnergyPercent: roundHalfUp(
      (carbohydrateKcal / input.targetEnergyKcal) * 100,
      1
    ),
    fiberRangeG: policy.fiberRangeG,
    saturatedFatMaxExclusiveG: exclusiveUpperBoundToTenths(
      input.targetEnergyKcal
        * policy.saturatedFatEnergyMaxExclusive
        / policy.kcalPerGram.fat
    ),
    addedSugarMaxExclusiveG: exclusiveUpperBoundToTenths(
      input.targetEnergyKcal
        * policy.addedSugarEnergyMaxExclusive
        / policy.kcalPerGram.carbohydrate
    ),
    policy
  };
}
