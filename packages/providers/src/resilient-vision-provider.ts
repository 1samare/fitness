import { visionProviderResponseSchema } from '@fitness/contracts';
import type { VisionProvider } from '@fitness/domain';
import { ProviderUnavailableError, VISION_PROVIDER_POLICY_V1 } from './vision-provider-policy';

export interface ProviderObservation {
  readonly provider: string;
  readonly requestId: string;
  readonly attempt: number;
  readonly latencyMs: number;
  readonly status: 'succeeded' | 'failed';
  readonly stableErrorCode?: 'provider_unavailable';
  readonly estimatedCostUnits?: number;
}

export interface VisionBackend {
  recognizePrivateFile(privateFileId: string): Promise<unknown>;
}

export interface ResilientVisionProviderOptions {
  readonly providerName: string;
  readonly backend: VisionBackend;
  readonly nowMs: () => number;
  readonly observe: (event: ProviderObservation) => void;
}

export class ResilientVisionProvider implements VisionProvider {
  private consecutiveFailures = 0;
  private openedAtMs: number | null = null;
  private halfOpenInFlight = false;

  public constructor(private readonly options: ResilientVisionProviderOptions) {}

  public async recognize(input: { readonly privateFileId: string; readonly requestId: string }): Promise<{
    readonly providerRequestId: string;
    readonly candidates: readonly {
      readonly providerCandidateId: string;
      readonly name: string;
      readonly confidence: number;
      readonly foodState: 'raw' | 'cooked' | 'dry' | 'unknown';
    }[];
  }> {
    const isHalfOpen = this.enterCircuit(input.requestId);
    try {
      for (let attempt = 1; attempt <= VISION_PROVIDER_POLICY_V1.retryCount + 1; attempt += 1) {
        const startedAtMs = this.options.nowMs();
        try {
          const response = await callWithTimeout(
            this.options.backend.recognizePrivateFile(input.privateFileId),
            VISION_PROVIDER_POLICY_V1.timeoutMs
          );
          const parsed = visionProviderResponseSchema.safeParse(response);
          if (!parsed.success) throw new ProviderUnavailableError('invalid_response');
          const latencyMs = Math.max(0, this.options.nowMs() - startedAtMs);
          this.observe(observation({
            provider: this.options.providerName,
            requestId: input.requestId,
            attempt,
            latencyMs,
            status: 'succeeded',
            estimatedCostUnits: parsed.data.estimatedCostUnits
          }));
          this.consecutiveFailures = 0;
          this.openedAtMs = null;
          return {
            providerRequestId: parsed.data.requestId,
            candidates: parsed.data.candidates
          };
        } catch (error: unknown) {
          const providerError = toProviderUnavailableError(error);
          const latencyMs = Math.max(0, this.options.nowMs() - startedAtMs);
          this.observe({
            provider: this.options.providerName,
            requestId: input.requestId,
            attempt,
            latencyMs,
            status: 'failed',
            stableErrorCode: providerError.code
          });
          const canRetry = providerError.reason === 'timeout' || providerError.reason === 'transport_unavailable';
          if (!canRetry || attempt > VISION_PROVIDER_POLICY_V1.retryCount) {
            this.recordFailure();
            throw providerError;
          }
        }
      }
      throw new ProviderUnavailableError('transport_unavailable');
    } finally {
      if (isHalfOpen) this.halfOpenInFlight = false;
    }
  }

  private enterCircuit(requestId: string): boolean {
    if (this.openedAtMs === null) return false;
    if (this.options.nowMs() - this.openedAtMs < VISION_PROVIDER_POLICY_V1.cooldownMs) {
      this.observe({
        provider: this.options.providerName,
        requestId,
        attempt: 0,
        latencyMs: 0,
        status: 'failed',
        stableErrorCode: 'provider_unavailable'
      });
      throw new ProviderUnavailableError('circuit_open');
    }
    if (this.halfOpenInFlight) {
      this.observe({
        provider: this.options.providerName,
        requestId,
        attempt: 0,
        latencyMs: 0,
        status: 'failed',
        stableErrorCode: 'provider_unavailable'
      });
      throw new ProviderUnavailableError('circuit_open');
    }
    this.halfOpenInFlight = true;
    return true;
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= VISION_PROVIDER_POLICY_V1.failureThreshold) {
      this.openedAtMs = this.options.nowMs();
    }
  }

  private observe(event: ProviderObservation): void {
    try {
      this.options.observe(event);
    } catch {
      // Observation failures must not alter recognition outcomes or circuit state.
    }
  }
}

export class UnavailableVisionProvider implements VisionProvider {
  public recognize(input: { readonly privateFileId: string; readonly requestId: string }): Promise<never> {
    void input;
    return Promise.reject(new ProviderUnavailableError('vision_provider_unavailable'));
  }
}

function callWithTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ProviderUnavailableError('timeout'));
    }, timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new ProviderUnavailableError('request_rejected'));
      }
    );
  });
}

function toProviderUnavailableError(error: unknown): ProviderUnavailableError {
  if (error instanceof ProviderUnavailableError) return error;
  return new ProviderUnavailableError('request_rejected');
}

function observation(event: {
  readonly provider: string;
  readonly requestId: string;
  readonly attempt: number;
  readonly latencyMs: number;
  readonly status: 'succeeded';
  readonly estimatedCostUnits: number | undefined;
}): ProviderObservation {
  if (event.estimatedCostUnits === undefined) {
    return {
      provider: event.provider,
      requestId: event.requestId,
      attempt: event.attempt,
      latencyMs: event.latencyMs,
      status: event.status
    };
  }
  return {
    provider: event.provider,
    requestId: event.requestId,
    attempt: event.attempt,
    latencyMs: event.latencyMs,
    status: event.status,
    estimatedCostUnits: event.estimatedCostUnits
  };
}
