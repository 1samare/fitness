export type WebBuildMode = 'normal' | 'test';

export interface WebBuildConfig {
  readonly mode: WebBuildMode;
  readonly testLlmConfig:
    | null
    | {
        readonly baseUrl: string;
        readonly apiKey: string;
        readonly model: string;
      };
  readonly cspConnectSource: readonly string[];
}

const LOCAL_TEST_HOST_PATTERNS = [
  /^https?:\/\/localhost(?::\d+)?(?:\/.*)?$/i,
  /^https?:\/\/127\.0\.0\.1(?::\d+)?(?:\/.*)?$/i
];

function getEnvValue(env: Record<string, string | undefined>, name: string): string {
  const raw = env[name];
  if (typeof raw !== 'string') {
    return '';
  }
  return raw.trim();
}

function isLocalHttp(url: string): boolean {
  return LOCAL_TEST_HOST_PATTERNS.some((pattern) => pattern.test(url));
}

function isHttpsOrLocalDev(url: string): boolean {
  if (url.startsWith('https://')) return true;
  return isLocalHttp(url);
}

function buildMode(mode: string): WebBuildMode {
  return mode === 'test' ? 'test' : 'normal';
}

export function resolveWebBuildConfig(
  mode: string,
  env: Record<string, string | undefined>
): WebBuildConfig {
  const buildModeValue = buildMode(mode);
  const testLlmApiKey = getEnvValue(env, 'VITE_TEST_LLM_API_KEY');
  const testLlmBaseUrl = getEnvValue(env, 'VITE_TEST_LLM_BASE_URL');
  const testLlmModel = getEnvValue(env, 'VITE_TEST_LLM_MODEL');

  if (buildModeValue === 'normal') {
    if (testLlmApiKey !== '') {
      throw new Error('build:web should not carry VITE_TEST_LLM_API_KEY in normal mode');
    }
    return {
      mode: 'normal',
      testLlmConfig: null,
      cspConnectSource: ["'self'"]
    };
  }

  if (testLlmBaseUrl === '' || testLlmApiKey === '' || testLlmModel === '') {
    throw new Error('build:web:test requires VITE_TEST_LLM_BASE_URL, VITE_TEST_LLM_API_KEY and VITE_TEST_LLM_MODEL');
  }
  if (!isHttpsOrLocalDev(testLlmBaseUrl)) {
    throw new Error('build:web:test requires https base URL or local localhost URL in dev mode');
  }

  return {
    mode: 'test',
    testLlmConfig: { baseUrl: testLlmBaseUrl, apiKey: testLlmApiKey, model: testLlmModel },
    cspConnectSource: ["'self'", new URL(testLlmBaseUrl).origin]
  };
}
