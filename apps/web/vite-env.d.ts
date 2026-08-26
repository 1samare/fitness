/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TEST_LLM_BASE_URL: string | undefined;
  readonly VITE_TEST_LLM_API_KEY: string | undefined;
  readonly VITE_TEST_LLM_MODEL: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __APP_VERSION__: string;
declare const __WEB_BUILD_MODE__: 'normal' | 'test';
declare const __TEST_LLM_BASE_URL__: string;
declare const __TEST_LLM_API_KEY__: string;
declare const __TEST_LLM_MODEL__: string;
