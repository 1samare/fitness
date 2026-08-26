import { describe, expect, it, vi } from 'vitest';
import { runWebTestPreflight } from '../../scripts/web-test-preflight.mjs';

const TEST_ENV = {
  VITE_TEST_LLM_BASE_URL: 'https://model.example.test/v1',
  VITE_TEST_LLM_API_KEY: 'preflight-secret',
  VITE_TEST_LLM_MODEL: 'fixed-model'
};

describe('runWebTestPreflight', () => {
  it('fails safely without making a request when configuration is missing', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await runWebTestPreflight({
      processEnvironment: {},
      fetchImpl
    });

    expect(result).toEqual({ ok: false, status: 'not_configured', latencyMs: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns only sanitized availability, latency and token metadata', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({
      id: 'synthetic-request-id',
      choices: [{ message: { content: '{"status":"ok"}' } }],
      usage: { total_tokens: 11 }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })));
    const times = [100, 142];
    const result = await runWebTestPreflight({
      processEnvironment: TEST_ENV,
      fetchImpl,
      nowMs: () => times.shift() ?? 142
    });

    expect(result).toEqual({
      ok: true,
      status: 'available',
      latencyMs: 42,
      requestIdPresent: true,
      totalTokens: 11
    });
    expect(JSON.stringify(result)).not.toContain('preflight-secret');
    expect(JSON.stringify(result)).not.toContain('synthetic-request-id');
  });

  it.each([
    [401, 'auth_failed'],
    [403, 'auth_failed'],
    [429, 'rate_limited'],
    [500, 'provider_unavailable']
  ] as const)('maps HTTP %s to %s without returning a response body', async (status, expected) => {
    const result = await runWebTestPreflight({
      processEnvironment: TEST_ENV,
      fetchImpl: vi.fn<typeof fetch>(() => Promise.resolve(new Response('sensitive supplier body', { status }))),
      nowMs: () => 100
    });

    expect(result).toEqual({ ok: false, status: expected, latencyMs: 0 });
    expect(JSON.stringify(result)).not.toContain('sensitive supplier body');
  });
});
