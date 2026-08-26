import {
  ResilientLanguageModelProvider,
  type LanguageModelProviderObservation
} from '@fitness/providers/browser';
import { OpenAICompatibleBrowserBackend } from './openai-compatible-browser-backend';
import { OpenAICompatibleBrowserVisionBackend } from './openai-compatible-browser-vision';

export interface BrowserProviderConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs?: number;
}

export interface BrowserProviderBundle {
  readonly languageModelProvider: ResilientLanguageModelProvider;
  readonly visionBackend: OpenAICompatibleBrowserVisionBackend;
  readonly display: {
    readonly endpointOrigin: string;
    readonly model: string;
  };
  readonly observations: readonly LanguageModelProviderObservation[];
}

export function createBrowserProviderBundle(
  config: BrowserProviderConfig,
  fetchImpl?: typeof fetch
): BrowserProviderBundle {
  const browserFetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const observations: LanguageModelProviderObservation[] = [];
  const backend = new OpenAICompatibleBrowserBackend({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    fetch: browserFetch
  });
  return {
    languageModelProvider: new ResilientLanguageModelProvider({
      providerId: 'openai-compatible-browser-test',
      modelName: config.model,
      backend,
      nowMs: () => Date.now(),
      observe: (event) => { observations.push(event); }
    }),
    visionBackend: new OpenAICompatibleBrowserVisionBackend({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      fetch: browserFetch
    }),
    display: {
      endpointOrigin: new URL(config.baseUrl).origin,
      model: config.model
    },
    observations
  };
}

export function createBuildBrowserProviderBundle(): BrowserProviderBundle | null {
  if (
    __WEB_BUILD_MODE__ !== 'test'
    || __TEST_LLM_BASE_URL__ === ''
    || __TEST_LLM_API_KEY__ === ''
    || __TEST_LLM_MODEL__ === ''
  ) {
    return null;
  }
  return createBrowserProviderBundle({
    baseUrl: __TEST_LLM_BASE_URL__,
    apiKey: __TEST_LLM_API_KEY__,
    model: __TEST_LLM_MODEL__
  });
}
