export const VISION_PROVIDER_POLICY_V1 = Object.freeze({
  policyVersion: 'vision-provider-policy-v1' as const,
  timeoutMs: 8_000,
  retryCount: 1 as const,
  failureThreshold: 3,
  cooldownMs: 60_000,
  maximumCandidates: 5,
  maximumFileBytes: 10 * 1024 * 1024
});

export class ProviderUnavailableError extends Error {
  public readonly code = 'provider_unavailable' as const;

  public constructor(public readonly reason: 'circuit_open' | 'invalid_response' | 'request_rejected' | 'transport_unavailable' | 'timeout' | 'vision_provider_unavailable') {
    super('Vision provider is unavailable');
    this.name = 'ProviderUnavailableError';
  }
}

export class StorageUnavailableError extends Error {
  public readonly code = 'storage_unavailable' as const;

  public constructor() {
    super('Private photo storage is unavailable');
    this.name = 'StorageUnavailableError';
  }
}
