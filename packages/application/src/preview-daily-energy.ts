import { calculateDailyEnergy, findReviewedTrainingSession } from '@fitness/calculation';
import type { PreviewDailyEnergyRequest } from '@fitness/contracts';
import type { DailyEnergyResult } from '@fitness/domain';

export class UnknownTrainingSessionError extends Error {
  public readonly code = 'unknown_training_session' as const;

  public constructor(public readonly sessionCode: string) {
    super(`Training session ${sessionCode} is not in the reviewed dataset`);
    this.name = 'UnknownTrainingSessionError';
  }
}

export function previewDailyEnergy(
  payload: PreviewDailyEnergyRequest['payload']
): DailyEnergyResult {
  const { training, ...command } = payload;
  if (training === undefined) return calculateDailyEnergy(command);
  const session = findReviewedTrainingSession(training.sessionCode);
  if (session === undefined) throw new UnknownTrainingSessionError(training.sessionCode);
  return calculateDailyEnergy({
    ...command,
    training: { session, durationMinutes: training.durationMinutes }
  });
}
