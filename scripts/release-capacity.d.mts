export interface CapacityEvidence {
  readonly schemaVersion: 'phase-7-capacity-evidence-v1';
  readonly mode: 'local_baseline' | 'cloud_controlled_beta';
  readonly identityLabelHashesSha256: readonly string[];
  readonly identityCount: number;
  readonly operationsPerIdentity: number;
  readonly totalOperations: number;
  readonly planningSuccessRate: number;
  readonly providerBoundedOutcomeRate: number;
  readonly p95LatencyMs: number;
  readonly crossUserLeakCount: number;
  readonly partialTransactionCount: number;
  readonly duplicateEffectiveVersionCount: number;
  readonly lostCleanupCount: number;
  readonly providerTimeoutViolationCount: number;
  readonly quotaViolationCount: number;
  readonly budgetExceeded: boolean;
  readonly status: 'passed';
}

export function validateCapacityResult(input: {
  readonly inputPath: string;
  readonly evidenceDirectory: string;
}): Promise<CapacityEvidence>;
