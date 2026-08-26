import type { AssistantLanguageModelInput } from '@fitness/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LanguageModelBackendError,
  type AssistantLanguageModelBackend
} from './language-model-backend';
import {
  ResilientLanguageModelProvider,
  type LanguageModelProviderObservation
} from './resilient-language-model-provider';

const input: AssistantLanguageModelInput = {
  requestId: 'assistant-turn-0001-model',
  systemPrompt: 'SECRET SYSTEM PROMPT',
  messages: [{ role: 'user', content: 'userId=private-user API_KEY=secret' }],
  repairAttempt: 0
};

afterEach(() => {
  vi.useRealTimers();
});

function providerHarness(options: {
  readonly backend: AssistantLanguageModelBackend;
  readonly nowMs?: () => number;
  readonly observations?: LanguageModelProviderObservation[];
}) {
  const observations = options.observations ?? [];
  const provider = new ResilientLanguageModelProvider({
    providerId: 'openai-compatible-browser-test',
    modelName: 'deepseek-v4-flash',
    backend: options.backend,
    nowMs: options.nowMs ?? (() => Date.now()),
    observe: (event) => {
      observations.push(event);
    }
  });
  return { provider, observations };
}

describe('ResilientLanguageModelProvider', () => {
  it('returns model output and emits only the whitelisted observation fields', async () => {
    let nowMs = 10;
    const backend = {
      generate: vi.fn(() => {
        nowMs = 25;
        return Promise.resolve({
          rawText: '{"kind":"reject","reason":"unsupported_request"}',
          requestId: 'supplier-request-1',
          estimatedCostUnits: 18
        });
      })
    };
    const { provider, observations } = providerHarness({ backend, nowMs: () => nowMs });

    await expect(provider.generateIntent(input)).resolves.toEqual({
      rawText: '{"kind":"reject","reason":"unsupported_request"}',
      requestId: 'supplier-request-1'
    });
    expect(observations).toEqual([{
      provider: 'openai-compatible-browser-test',
      model: 'deepseek-v4-flash',
      requestId: 'supplier-request-1',
      repairAttempt: 0,
      attempt: 1,
      latencyMs: 15,
      status: 'succeeded',
      estimatedCostUnits: 18
    }]);
    const serialized = JSON.stringify(observations);
    expect(serialized).not.toMatch(/SECRET|private-user|API_KEY|rawText|messages/i);
  });

  it('times out after 20 seconds and retries only once', async () => {
    vi.useFakeTimers();
    const backend = {
      generate: vi.fn()
        .mockImplementationOnce(() => new Promise(() => undefined))
        .mockResolvedValueOnce({ rawText: '{}' })
    };
    const { provider } = providerHarness({ backend });
    const operation = provider.generateIntent(input);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(operation).resolves.toEqual({ rawText: '{}' });
    expect(backend.generate).toHaveBeenCalledTimes(2);
  });

  it('retries one transient error but not an invalid response', async () => {
    const transientBackend = {
      generate: vi.fn()
        .mockRejectedValueOnce(new LanguageModelBackendError('transport_unavailable', true))
        .mockResolvedValueOnce({ rawText: '{}' })
    };
    const transient = providerHarness({ backend: transientBackend }).provider;
    await expect(transient.generateIntent(input)).resolves.toEqual({ rawText: '{}' });
    expect(transientBackend.generate).toHaveBeenCalledTimes(2);

    const invalidBackend = {
      generate: vi.fn().mockRejectedValue(new LanguageModelBackendError('invalid_response', false))
    };
    const invalid = providerHarness({ backend: invalidBackend }).provider;
    await expect(invalid.generateIntent(input)).rejects.toMatchObject({
      reason: 'invalid_response'
    });
    expect(invalidBackend.generate).toHaveBeenCalledOnce();
  });

  it('opens after three failed operations, not three transport attempts', async () => {
    let nowMs = 0;
    const backend = {
      generate: vi.fn().mockRejectedValue(
        new LanguageModelBackendError('transport_unavailable', true)
      )
    };
    const { provider } = providerHarness({ backend, nowMs: () => nowMs });
    for (let operation = 0; operation < 3; operation += 1) {
      await expect(provider.generateIntent({
        ...input,
        requestId: `operation-${String(operation)}`
      })).rejects.toMatchObject({ code: 'provider_unavailable' });
    }
    expect(backend.generate).toHaveBeenCalledTimes(6);
    await expect(provider.generateIntent({ ...input, requestId: 'circuit-open' }))
      .rejects.toMatchObject({ reason: 'circuit_open' });
    expect(backend.generate).toHaveBeenCalledTimes(6);
    nowMs = 60_000;
  });

  it('allows one half-open probe, rejects concurrent calls, and closes after success', async () => {
    let nowMs = 0;
    let resolveProbe: ((value: { readonly rawText: string }) => void) | undefined;
    const backend = {
      generate: vi.fn().mockRejectedValue(
        new LanguageModelBackendError('invalid_response', false)
      )
    };
    const { provider } = providerHarness({ backend, nowMs: () => nowMs });
    for (let operation = 0; operation < 3; operation += 1) {
      await expect(provider.generateIntent({
        ...input,
        requestId: `failure-${String(operation)}`
      })).rejects.toMatchObject({ code: 'provider_unavailable' });
    }
    expect(backend.generate).toHaveBeenCalledTimes(3);
    nowMs = 60_000;
    backend.generate.mockImplementationOnce(() => new Promise((resolve) => {
      resolveProbe = resolve;
    }));
    const probe = provider.generateIntent({ ...input, requestId: 'half-open-probe' });
    await expect(provider.generateIntent({ ...input, requestId: 'blocked-concurrent' }))
      .rejects.toMatchObject({ reason: 'circuit_open' });
    expect(backend.generate).toHaveBeenCalledTimes(4);
    resolveProbe?.({ rawText: '{}' });
    await expect(probe).resolves.toEqual({ rawText: '{}' });

    backend.generate.mockResolvedValueOnce({ rawText: '{"ok":true}' });
    await expect(provider.generateIntent({ ...input, requestId: 'closed-again' }))
      .resolves.toEqual({ rawText: '{"ok":true}' });
    expect(backend.generate).toHaveBeenCalledTimes(5);
  });

  it('does not let observation failures change outcomes or circuit state', async () => {
    const backend = { generate: vi.fn().mockResolvedValue({ rawText: '{}' }) };
    const provider = new ResilientLanguageModelProvider({
      providerId: 'openai-compatible-browser-test',
      modelName: 'hunyuan-turbos-latest',
      backend,
      nowMs: () => 0,
      observe: () => {
        throw new Error('observer unavailable');
      }
    });
    await expect(provider.generateIntent(input)).resolves.toEqual({ rawText: '{}' });
  });
});
