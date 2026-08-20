import type { PlanningAggregateState } from '@fitness/domain';

export const PLANNING_AGGREGATE_MAX_UTF8_BYTES = 3_000_000;

export function planningAggregateUtf8Bytes(state: PlanningAggregateState): number {
  return new TextEncoder().encode(JSON.stringify(state)).byteLength;
}

export class AccountCapacityExceededError extends Error {
  public readonly code = 'account_capacity_exceeded' as const;

  public constructor(
    public readonly actualBytes: number,
    public readonly maximumBytes = PLANNING_AGGREGATE_MAX_UTF8_BYTES
  ) {
    super(
      `Planning aggregate uses ${String(actualBytes)} UTF-8 bytes; maximum is ${String(maximumBytes)}`
    );
    this.name = 'AccountCapacityExceededError';
  }
}

export function assertPlanningAggregateCapacity(state: PlanningAggregateState): void {
  const actualBytes = planningAggregateUtf8Bytes(state);
  if (actualBytes > PLANNING_AGGREGATE_MAX_UTF8_BYTES) {
    throw new AccountCapacityExceededError(actualBytes);
  }
}

function businessStateJson(state: PlanningAggregateState): string {
  const { accountDeletion, ...businessState } = state;
  void accountDeletion;
  return JSON.stringify(businessState);
}

export function assertPlanningAggregateCapacityTransition(
  current: PlanningAggregateState,
  next: PlanningAggregateState
): void {
  if (planningAggregateUtf8Bytes(next) <= PLANNING_AGGREGATE_MAX_UTF8_BYTES) return;
  const isLegacyDeletionOnlyTransition = (
    planningAggregateUtf8Bytes(current) > PLANNING_AGGREGATE_MAX_UTF8_BYTES
    && next.accountDeletion !== null
    && businessStateJson(current) === businessStateJson(next)
  );
  if (!isLegacyDeletionOnlyTransition) {
    throw new AccountCapacityExceededError(planningAggregateUtf8Bytes(next));
  }
}
