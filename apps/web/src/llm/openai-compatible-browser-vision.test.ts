import { describe, expect, test, vi } from 'vitest';
import {
  BrowserVisionBackendError,
  OpenAICompatibleBrowserVisionBackend
} from './openai-compatible-browser-vision';

function jsonResponse(content: unknown, status = 200): Response {
  return new Response(JSON.stringify({
    id: 'vision-supplier-request-001',
    choices: [{ message: { content: JSON.stringify(content) } }]
  }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function backend(fetchImpl: typeof fetch): OpenAICompatibleBrowserVisionBackend {
  return new OpenAICompatibleBrowserVisionBackend({
    baseUrl: 'https://fixture.invalid/v1',
    apiKey: 'synthetic-vision-key',
    model: 'fixture-vision-model',
    fetch: fetchImpl,
    timeoutMs: 100
  });
}

const input = {
  requestId: 'vision-request-001',
  dataUrl: 'data:image/jpeg;base64,Zm9vZA==',
  mediaType: 'image/jpeg' as const
};

describe('OpenAICompatibleBrowserVisionBackend', () => {
  test('sends a fixed multimodal request and returns only strict candidate fields', async () => {
    const fetchStub = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({
      candidates: [{ name: '测试苹果', confidence: 0.96, foodState: 'raw' }]
    })));

    const result = await backend(fetchStub).recognize(input);

    const [url, init] = fetchStub.mock.calls[0] ?? [];
    expect(url).toBe('https://fixture.invalid/v1/chat/completions');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer synthetic-vision-key',
        'Content-Type': 'application/json'
      }
    });
    const requestBody = init?.body;
    if (typeof requestBody !== 'string') throw new Error('Expected JSON request body');
    const body: unknown = JSON.parse(requestBody);
    expect(body).toMatchObject({
      model: 'fixture-vision-model',
      stream: false,
      messages: [{
        content: [
          expect.any(Object),
          { type: 'image_url', image_url: { url: input.dataUrl } }
        ]
      }]
    });
    expect(result).toEqual({
      requestId: 'vision-supplier-request-001',
      candidates: [{ name: '测试苹果', confidence: 0.96, foodState: 'raw' }]
    });
  });

  test.each([
    {
      name: 'model-provided grams',
      response: jsonResponse({
        candidates: [{ name: '测试苹果', confidence: 0.9, foodState: 'raw', grams: 200 }]
      })
    },
    {
      name: 'more than five candidates',
      response: jsonResponse({
        candidates: Array.from({ length: 6 }, (_, index) => ({
          name: `测试食材${String(index)}`,
          confidence: 0.8,
          foodState: 'raw'
        }))
      })
    },
    { name: 'invalid candidate JSON', response: jsonResponse('not-an-object') },
    { name: 'CORS-like rejection', response: new TypeError('Failed to fetch') },
    { name: 'HTTP 429', response: new Response('', { status: 429 }) }
  ])('fails closed for $name', async ({ response }) => {
    const fetchStub = vi.fn<typeof fetch>(() => (
      response instanceof Error ? Promise.reject(response) : Promise.resolve(response)
    ));

    const failure = await backend(fetchStub).recognize(input).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BrowserVisionBackendError);
    expect(failure).toMatchObject({ code: 'vision_unavailable' });
    expect(String(failure)).not.toContain('synthetic-vision-key');
  });
});
