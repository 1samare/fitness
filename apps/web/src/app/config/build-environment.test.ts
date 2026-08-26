import { describe, expect, it } from 'vitest';
import { resolveWebBuildConfig } from './build-environment';

const TEST_ENV = {
  VITE_TEST_LLM_BASE_URL: 'https://model.example.test/v1',
  VITE_TEST_LLM_API_KEY: 'test-secret',
  VITE_TEST_LLM_MODEL: 'fixed-model'
};

describe('resolveWebBuildConfig', () => {
  it('injects the fixed endpoint, key and model only into a test build', () => {
    expect(resolveWebBuildConfig('test', TEST_ENV)).toMatchObject({
      mode: 'test',
      testLlmConfig: {
        baseUrl: 'https://model.example.test/v1',
        apiKey: 'test-secret',
        model: 'fixed-model'
      }
    });
  });

  it('rejects a normal build that carries a test API key', () => {
    expect(() => resolveWebBuildConfig('normal', TEST_ENV)).toThrow(
      'build:web should not carry VITE_TEST_LLM_API_KEY in normal mode'
    );
  });

  it('rejects incomplete or insecure test configuration', () => {
    expect(() => resolveWebBuildConfig('test', {
      ...TEST_ENV,
      VITE_TEST_LLM_API_KEY: ''
    })).toThrow('build:web:test requires');
    expect(() => resolveWebBuildConfig('test', {
      ...TEST_ENV,
      VITE_TEST_LLM_BASE_URL: 'http://model.example.test/v1'
    })).toThrow('https base URL');
  });
});
