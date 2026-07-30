import type { EligibilityInput, UnsupportedReason } from '@fitness/domain';
import { CALCULATION_POLICY_V2 } from './policy';

export interface EligibilityResult {
  readonly bmi: number;
  readonly reasons: UnsupportedReason[];
}

export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  const heightM = input.heightCm / 100;
  const bmi = input.weightKg / (heightM * heightM);
  const reasons: UnsupportedReason[] = [];
  const ageRange = CALCULATION_POLICY_V2.applicableAgeRange;
  const bmiRange = CALCULATION_POLICY_V2.applicableBmiRange;

  if (input.ageYears < ageRange.minInclusive || input.ageYears > ageRange.maxInclusive) {
    reasons.push('age_out_of_range');
  }
  if (bmi < bmiRange.minInclusive || bmi >= bmiRange.maxExclusive) {
    reasons.push('bmi_out_of_range');
  }
  if (!input.healthScopeConfirmed) {
    reasons.push('health_scope_not_confirmed');
  }

  return { bmi, reasons };
}
