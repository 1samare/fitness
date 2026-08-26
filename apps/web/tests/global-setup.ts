import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const baseURL = 'http://127.0.0.1:4173';

export default async function globalSetup(): Promise<() => Promise<void>> {
  process.env.VITE_TEST_LLM_BASE_URL = `${baseURL}/__playwright__/v1`;
  process.env.VITE_TEST_LLM_API_KEY = 'playwright-synthetic-key-not-real';
  process.env.VITE_TEST_LLM_MODEL = 'playwright-fixed-model';
  const server = await createServer({
    root: webRoot,
    configFile: resolve(webRoot, 'vite.config.ts'),
    mode: 'test',
    server: { host: '127.0.0.1', port: 4173, strictPort: true }
  });
  await server.listen();
  return async () => {
    await server.close();
  };
}
