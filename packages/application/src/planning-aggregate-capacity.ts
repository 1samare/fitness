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
