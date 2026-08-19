import { afterEach, describe, expect, test, vi } from 'vitest';
import { ResilientVisionProvider, UnavailableVisionProvider } from './resilient-vision-provider';

afterEach(() => {
  vi.useRealTimers();
});

describe('ResilientVisionProvider', () => {
  test('retries one timed-out operation and returns its second valid response', async () => {
    vi.useFakeTimers();
    const backend = {
      recognizePrivateFile: vi.fn()
        .mockImplementationOnce(() => new Promise(() => undefined))
        .mockResolvedValueOnce({
          requestId: 'provider-request-2',
          candidates: [{
            providerCandidateId: 'candidate-1',
            name: '鸡胸肉',
            confidence: 0.9,
            foodState: 'raw'
          }]
        })
    };
    const provider = new ResilientVisionProvider({
      providerName: 'fixture-vision',
      backend,
      nowMs: () => Date.now(),
      observe: () => undefined
    });

    const resultPromise = provider.recognize({
      privateFileId: 'cloud://private/photo.jpg',
      requestId: 'vision-request-1'
    });
    await vi.advanceTimersByTimeAsync(8_000);

    await expect(resultPromise).resolves.toMatchObject({ providerRequestId: 'provider-request-2' });
    expect(backend.recognizePrivateFile).toHaveBeenCalledTimes(2);
  });

  test('opens after three failed operations without observing sensitive values', async () => {
    let nowMs = 0;
    const observations: unknown[] = [];
    const backend = { recognizePrivateFile: vi.fn().mockRejectedValue(new Error('fileID=secret')) };
    const provider = new ResilientVisionProvider({
      providerName: 'fixture-vision',
      backend,
      nowMs: () => nowMs,
      observe: (event) => {
        observations.push(event);
      }
    });

    for (let operation = 0; operation < 3; operation += 1) {
      await expect(provider.recognize({
        privateFileId: 'cloud://secret/photo.jpg',
        requestId: `request-${String(operation)}`
      })).rejects.toMatchObject({ code: 'provider_unavailable' });
    }

    await expect(provider.recognize({
      privateFileId: 'cloud://secret/photo.jpg',
      requestId: 'request-open'
    })).rejects.toMatchObject({ reason: 'circuit_open' });
    expect(JSON.stringify(observations)).not.toContain('cloud://secret');
    expect(JSON.stringify(observations)).not.toContain('fileID=secret');
    nowMs = 60_000;
  });

  test('does not retry a malformed provider response', async () => {
    const backend = {
      recognizePrivateFile: vi.fn().mockResolvedValue({
        requestId: 'provider-request-malformed',
        candidates: [],
        privateFileId: 'cloud://unexpected'
      })
    };
    const provider = new ResilientVisionProvider({
      providerName: 'fixture-vision',
      backend,
      nowMs: () => 0,
      observe: () => undefined
    });

    await expect(provider.recognize({
      privateFileId: 'cloud://private/photo.jpg',
      requestId: 'vision-request-malformed'
    })).rejects.toMatchObject({ code: 'provider_unavailable', reason: 'invalid_response' });
    expect(backend.recognizePrivateFile).toHaveBeenCalledTimes(1);
  });

  test('allows one half-open call after the cooldown', async () => {
    let nowMs = 0;
    const backend = { recognizePrivateFile: vi.fn().mockRejectedValue(new Error('transport unavailable')) };
    const provider = new ResilientVisionProvider({
      providerName: 'fixture-vision',
      backend,
      nowMs: () => nowMs,
      observe: () => undefined
    });

    for (let operation = 0; operation < 3; operation += 1) {
      await expect(provider.recognize({
        privateFileId: 'cloud://private/photo.jpg',
        requestId: `request-${String(operation)}`
      })).rejects.toMatchObject({ code: 'provider_unavailable' });
    }
    nowMs = 60_000;
    const halfOpenOperation = provider.recognize({
      privateFileId: 'cloud://private/photo.jpg',
      requestId: 'request-half-open'
    });
    await expect(provider.recognize({
      privateFileId: 'cloud://private/photo.jpg',
      requestId: 'request-blocked-half-open'
    })).rejects.toMatchObject({ reason: 'circuit_open' });
    await expect(halfOpenOperation).rejects.toMatchObject({ code: 'provider_unavailable' });
  });
});

test('UnavailableVisionProvider rejects with a stable manual-entry fallback error', async () => {
  await expect(new UnavailableVisionProvider().recognize({
    privateFileId: 'cloud://private/photo.jpg',
    requestId: 'vision-request-1'
  })).rejects.toMatchObject({
    code: 'provider_unavailable',
    reason: 'vision_provider_unavailable'
  });
});
