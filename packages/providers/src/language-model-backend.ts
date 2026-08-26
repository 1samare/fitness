import type { AssistantLanguageModelInput } from '@fitness/agent';

export type LanguageModelBackendFailureReason =
  | 'transport_unavailable'
  | 'timeout'
  | 'invalid_response'
  | 'supplier_error'
  | 'cors_unavailable'
  | 'auth_failed'
  | 'rate_limited'
  | 'circuit_open';

export type LanguageModelProviderErrorCode =
  | 'provider_cors_unavailable'
  | 'provider_auth_failed'
  | 'provider_rate_limited'
  | 'provider_unavailable';

export class LanguageModelBackendError extends Error {
  public constructor(
    public readonly reason: LanguageModelBackendFailureReason,
    public readonly transient: boolean,
    public readonly code: LanguageModelProviderErrorCode = 'provider_unavailable'
  ) {
    super('Language model Provider is unavailable');
    this.name = 'LanguageModelBackendError';
  }
}

export interface AssistantLanguageModelBackendResult {
  readonly rawText: string;
  readonly requestId?: string;
  readonly estimatedCostUnits?: number;
}

export interface AssistantLanguageModelBackend {
  generate(input: AssistantLanguageModelInput): Promise<AssistantLanguageModelBackendResult>;
}
