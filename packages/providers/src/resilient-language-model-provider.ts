import type {
  AssistantLanguageModelInput,
  AssistantLanguageModelProvider,
  AssistantLanguageModelResult
} from '@fitness/agent';
import { z } from 'zod';
import {
  LanguageModelBackendError,
  type AssistantLanguageModelBackend,
  type AssistantLanguageModelBackendResult
} from './language-model-backend';

const LANGUAGE_MODEL_POLICY = {
  timeoutMs: 20_000,
  retryCount: 1,
  failureThreshold: 3,
  cooldownMs: 60_000
} as const;

export const languageModelProviderObservationSchema = z.object({
  provider: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(128),
  requestId: z.string().trim().min(1).max(256),
  repairAttempt: z.union([z.literal(0), z.literal(1)]),
  attempt: z.number().int().min(0).max(2),
  latencyMs: z.number().nonnegative(),
  status: z.enum(['succeeded', 'failed']),
  estimatedCostUnits: z.number().nonnegative().optional()
}).strict();

export type LanguageModelProviderObservation = z.infer<
  typeof languageModelProviderObservationSchema
>;

export interface ResilientLanguageModelProviderOptions {
  readonly providerId: string;
  readonly modelName: string;
  readonly backend: AssistantLanguageModelBackend;
  readonly nowMs: () => number;
  readonly observe: (event: LanguageModelProviderObservation) => void;
}

function withTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new LanguageModelBackendError('timeout', true));
    }, LANGUAGE_MODEL_POLICY.timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error
          ? error
          : new LanguageModelBackendError('transport_unavailable', true));
      }
    );
  });
}

function stableError(error: unknown): LanguageModelBackendError {
  return error instanceof LanguageModelBackendError
    ? error
    : new LanguageModelBackendError('transport_unavailable', true);
}

function successfulObservation(input: {
  readonly provider: string;
  readonly model: string;
  readonly requestId: string;
  readonly repairAttempt: 0 | 1;
  readonly attempt: number;
  readonly latencyMs: number;
  readonly result: AssistantLanguageModelBackendResult;
}): LanguageModelProviderObservation {
  return {
    provider: input.provider,
    model: input.model,
    requestId: input.result.requestId ?? input.requestId,
    repairAttempt: input.repairAttempt,
    attempt: input.attempt,
    latencyMs: input.latencyMs,
    status: 'succeeded',
    ...(input.result.estimatedCostUnits === undefined
      ? {}
      : { estimatedCostUnits: input.result.estimatedCostUnits })
  };
}

export class ResilientLanguageModelProvider implements AssistantLanguageModelProvider {
  private consecutiveFailedOperations = 0;
  private openedAtMs: number | null = null;
  private halfOpenInFlight = false;

  public constructor(private readonly options: ResilientLanguageModelProviderOptions) {}

  public async generateIntent(
    input: AssistantLanguageModelInput
  ): Promise<AssistantLanguageModelResult> {
    const isHalfOpen = this.enterCircuit(input);
    try {
      for (let attempt = 1; attempt <= LANGUAGE_MODEL_POLICY.retryCount + 1; attempt += 1) {
        const startedAtMs = this.options.nowMs();
        try {
          const result = await withTimeout(this.options.backend.generate(input));
          this.observe(successfulObservation({
            provider: this.options.providerId,
            model: this.options.modelName,
            requestId: input.requestId,
            repairAttempt: input.repairAttempt,
            attempt,
            latencyMs: Math.max(0, this.options.nowMs() - startedAtMs),
            result
          }));
          this.consecutiveFailedOperations = 0;
          this.openedAtMs = null;
          return {
            rawText: result.rawText,
            ...(result.requestId === undefined ? {} : { requestId: result.requestId })
          };
        } catch (error: unknown) {
          const stable = stableError(error);
          this.observe({
            provider: this.options.providerId,
            model: this.options.modelName,
            requestId: input.requestId,
            repairAttempt: input.repairAttempt,
            attempt,
            latencyMs: Math.max(0, this.options.nowMs() - startedAtMs),
            status: 'failed'
          });
          if (stable.transient && attempt <= LANGUAGE_MODEL_POLICY.retryCount) continue;
          this.recordFailedOperation();
          throw stable;
        }
      }
      this.recordFailedOperation();
      throw new LanguageModelBackendError('transport_unavailable', true);
    } finally {
      if (isHalfOpen) this.halfOpenInFlight = false;
    }
  }

  private enterCircuit(input: AssistantLanguageModelInput): boolean {
    if (this.openedAtMs === null) return false;
    if (this.options.nowMs() - this.openedAtMs < LANGUAGE_MODEL_POLICY.cooldownMs
      || this.halfOpenInFlight) {
      this.observe({
        provider: this.options.providerId,
        model: this.options.modelName,
        requestId: input.requestId,
        repairAttempt: input.repairAttempt,
        attempt: 0,
        latencyMs: 0,
        status: 'failed'
      });
      throw new LanguageModelBackendError('circuit_open', false);
    }
    this.halfOpenInFlight = true;
    return true;
  }

  private recordFailedOperation(): void {
    this.consecutiveFailedOperations += 1;
    if (this.consecutiveFailedOperations >= LANGUAGE_MODEL_POLICY.failureThreshold) {
      this.openedAtMs = this.options.nowMs();
    }
  }

  private observe(event: LanguageModelProviderObservation): void {
    try {
      this.options.observe(languageModelProviderObservationSchema.parse(event));
    } catch {
      // Observability is isolated from model outcomes and circuit state.
    }
  }
}
