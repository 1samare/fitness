export class PastFactImmutableError extends Error {
  public readonly code = 'past_fact_immutable' as const;

  public constructor(public readonly businessDate: string) {
    super(`Meal plan facts on or before the current business date are immutable: ${businessDate}`);
    this.name = 'PastFactImmutableError';
  }
}

export class FutureCompletionForbiddenError extends Error {
  public readonly code = 'future_completion_forbidden' as const;

  public constructor(public readonly businessDate: string) {
    super(`Training completion cannot be recorded for a future business date: ${businessDate}`);
    this.name = 'FutureCompletionForbiddenError';
  }
}
