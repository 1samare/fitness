import type { DailyEnergyCommand, DailyEnergyResult, PolicyMetadata } from '@fitness/domain';
import { evaluateEligibility } from './eligibility';
import { CALCULATION_POLICY_V2 } from './policy';
import { roundHalfUp } from './rounding';

const DISCLAIMER = '初始估算，仅供一般健身与膳食规划参考，不构成医疗建议。';

function policyMetadata(extraSourceIds: readonly string[] = []): PolicyMetadata {
  return {
    policyVersion: CALCULATION_POLICY_V2.policyVersion,
    sourceIds: [...CALCULATION_POLICY_V2.sourceIds, ...extraSourceIds],
    applicableAgeRange: CALCULATION_POLICY_V2.applicableAgeRange,
    applicableBmiRange: CALCULATION_POLICY_V2.applicableBmiRange,
    rounding: CALCULATION_POLICY_V2.rounding
  };
}

export function calculateDailyEnergy(command: DailyEnergyCommand): DailyEnergyResult {
  const eligibility = evaluateEligibility(command);
  const bmi = roundHalfUp(eligibility.bmi, 2);
  if (eligibility.reasons.length > 0) {
    return {
      kind: 'unsupported',
      code: 'unsupported_for_personalized_energy',
      reasons: eligibility.reasons,
      bmi,
      policy: policyMetadata()
    };
  }

  const policy = CALCULATION_POLICY_V2;
  const bmr = policy.bmr.weightCoefficient * command.weightKg
    + policy.bmr.sexCoefficient * command.sexCode
    + policy.bmr.intercept;
  const baseline = bmr * policy.pal[command.nonTrainingActivity];
  const trainingNet = command.training === undefined
    ? 0
    : (command.training.session.met - 1) * 3.5 * command.weightKg / 200
      * command.training.durationMinutes;
  const maintenance = baseline + trainingNet;
  const target = maintenance * (1 + policy.goalAdjustment[command.goal]);
  const extraSourceIds = command.training === undefined ? [] : [command.training.session.sourceId];

  return {
    kind: 'supported',
    bmi,
    estimatedBmrKcal: roundHalfUp(bmr, 0),
    nonTrainingBaselineKcal: roundHalfUp(baseline, 0),
    trainingNetKcal: roundHalfUp(trainingNet, 0),
    estimatedMaintenanceKcal: roundHalfUp(maintenance, 0),
    targetEnergyKcal: roundHalfUp(target, 0),
    policy: policyMetadata(extraSourceIds),
    disclaimer: DISCLAIMER
  };
}
