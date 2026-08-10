export class PastFactImmutableError extends Error {
  public readonly code = 'past_fact_immutable' as const;

  public constructor(public readonly businessDate: string) {
    super(`Meal plan facts on or before the current business date are immutable: ${businessDate}`);
    this.name = 'PastFactImmutableError';
  }
}
