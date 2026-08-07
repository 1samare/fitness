import type { TrainingSessionPayload } from '@fitness/domain';

function sameSession(
  left: TrainingSessionPayload | undefined,
  right: TrainingSessionPayload | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.sessionCode === right.sessionCode
    && left.durationMinutes === right.durationMinutes;
}

export function affectedTrainingDates(
  previous: readonly TrainingSessionPayload[],
  next: readonly TrainingSessionPayload[],
  eligibleDates: readonly string[]
): string[] {
  const previousByDate = new Map(previous.map((session) => [session.businessDate, session]));
  const nextByDate = new Map(next.map((session) => [session.businessDate, session]));
  return [...new Set(eligibleDates)]
    .sort()
    .filter((businessDate) => !sameSession(
      previousByDate.get(businessDate),
      nextByDate.get(businessDate)
    ));
}
