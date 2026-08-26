import { describe, expect, it, vi } from 'vitest';
import { createBrowserProviderBundle } from './browser-provider-bundle';

describe('createBrowserProviderBundle', () => {
  it('exposes only safe display metadata and keeps the fixed model', () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const bundle = createBrowserProviderBundle({
      baseUrl: 'https://model.example.test/v1',
      apiKey: 'secret-test-key',
      model: 'fixed-test-model'
    }, fetchImpl);

    expect(bundle.display).toEqual({
      endpointOrigin: 'https://model.example.test',
      model: 'fixed-test-model'
    });
    expect(JSON.stringify(bundle.display)).not.toContain('secret-test-key');
    expect(bundle.observations).toEqual([]);
  });
});
