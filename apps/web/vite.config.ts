import { createRequire } from 'node:module';
import react from '@vitejs/plugin-react';
import { loadEnv, type PluginOption, defineConfig } from 'vite';
import { resolveWebBuildConfig } from './src/app/config/build-environment';
import { createContentSecurityPolicy } from './src/app/config/content-security-policy';

const require = createRequire(import.meta.url);
const pkg = require('./package.json') as { version: string };

function cspPlugin(connectSources: readonly string[]): PluginOption {
  return {
    name: 'fitness-browser-csp',
    enforce: 'post',
    transformIndexHtml(html) {
      const csp = createContentSecurityPolicy(connectSources);
      return html.replace(
        '</head>',
        `  <meta http-equiv="Content-Security-Policy" content="${csp}">\n</head>`
      );
    }
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const buildConfig = resolveWebBuildConfig(mode, env);

  return {
    plugins: [react(), cspPlugin(buildConfig.cspConnectSource)],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __WEB_BUILD_MODE__: JSON.stringify(buildConfig.mode),
      __TEST_LLM_BASE_URL__: JSON.stringify(buildConfig.testLlmConfig?.baseUrl ?? ''),
      __TEST_LLM_API_KEY__: JSON.stringify(buildConfig.testLlmConfig?.apiKey ?? ''),
      __TEST_LLM_MODEL__: JSON.stringify(buildConfig.testLlmConfig?.model ?? '')
    },
    test: {
      watch: false
    },
    build: {
      target: 'es2022'
    },
    server: {
      host: '127.0.0.1',
      strictPort: true
    },
    preview: {
      port: 4173
    }
  };
});
