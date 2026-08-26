import { describe, expect, test, vi } from 'vitest';
import {
  BrowserLanguageModelError,
  OpenAICompatibleBrowserBackend
} from './openai-compatible-browser-backend';

const input = {
  requestId: 'browser-model-request-001',
  systemPrompt: 'Return JSON only',
  messages: [{ role: 'user' as const, content: '把 2026-09-01 的训练移到 2026-09-02' }],
  repairAttempt: 0 as const
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function backend(fetchImpl: typeof fetch, timeoutMs = 100): OpenAICompatibleBrowserBackend {
  return new OpenAICompatibleBrowserBackend({
    baseUrl: 'https://fixture.invalid/v1',
    apiKey: 'synthetic-browser-key',
    model: 'fixture-model',
    fetch: fetchImpl,
    timeoutMs
  });
}

describe('OpenAICompatibleBrowserBackend', () => {
  test('uses only the fixed endpoint, model and bearer credential and returns sanitized metadata', async () => {
    const fetchStub = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({
      id: 'supplier-request-001',
      choices: [{ message: { content: '{"kind":"reject","reason":"unsupported_request"}' } }],
      usage: { total_tokens: 37 }
    })));

    const result = await backend(fetchStub).generate(input);

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0] ?? [];
    expect(url).toBe('https://fixture.invalid/v1/chat/completions');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer synthetic-browser-key',
        'Content-Type': 'application/json'
      }
    });
    const requestBody = init?.body;
    if (typeof requestBody !== 'string') throw new Error('Expected JSON request body');
    const parsedBody: unknown = JSON.parse(requestBody);
    expect(parsedBody).toMatchObject({
      model: 'fixture-model',
      stream: false,
      messages: [
        { role: 'system', content: 'Return JSON only' },
        { role: 'user', content: input.messages[0]?.content }
      ]
    });
    expect(result).toEqual({
      rawText: '{"kind":"reject","reason":"unsupported_request"}',
      requestId: 'supplier-request-001',
      estimatedCostUnits: 37
    });
  });

  test.each([
    { name: 'CORS-like fetch rejection', response: new TypeError('Failed to fetch'), code: 'provider_cors_unavailable' },
    { name: '401', response: jsonResponse({}, 401), code: 'provider_auth_failed' },
    { name: '403', response: jsonResponse({}, 403), code: 'provider_auth_failed' },
    { name: '429', response: jsonResponse({}, 429), code: 'provider_rate_limited' },
    { name: '500', response: jsonResponse({}, 500), code: 'provider_unavailable' },
    { name: 'invalid JSON', response: new Response('{', { status: 200 }), code: 'provider_unavailable' },
    { name: 'invalid schema', response: jsonResponse({ choices: [] }), code: 'provider_unavailable' }
  ])('maps $name without exposing supplier content', async ({ response, code }) => {
    const fetchStub = vi.fn<typeof fetch>(() => (
      response instanceof Error ? Promise.reject(response) : Promise.resolve(response)
    ));

    const failure = await backend(fetchStub).generate(input).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BrowserLanguageModelError);
    expect(failure).toMatchObject({ code });
    expect(String(failure)).not.toContain('synthetic-browser-key');
  });

  test('aborts a timed-out request and returns provider_unavailable', async () => {
    const fetchStub = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      });
    }));

    const failure = await backend(fetchStub, 1).generate(input).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BrowserLanguageModelError);
    expect(failure).toMatchObject({ code: 'provider_unavailable', reason: 'timeout', transient: true });
  });
});
