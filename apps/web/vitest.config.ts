import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify('0.1.0-test'),
    __WEB_BUILD_MODE__: JSON.stringify('ordinary'),
    __TEST_LLM_BASE_URL__: JSON.stringify(''),
    __TEST_LLM_API_KEY__: JSON.stringify(''),
    __TEST_LLM_MODEL__: JSON.stringify('')
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**'],
    passWithNoTests: false
  }
});
