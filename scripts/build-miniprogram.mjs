import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { argv, env } from 'node:process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(repositoryRoot, 'miniprogram');
const buildRoot = path.join(repositoryRoot, '.build');
const outputRoot = path.join(buildRoot, 'miniprogram');
const apiModeArgument = argv.find((argument) => argument.startsWith('--api-mode='));
const apiMode = apiModeArgument?.slice('--api-mode='.length) ?? 'cloud';
const releaseChannelArgument = argv.find((argument) => argument.startsWith('--release-channel='));
const releaseChannel = releaseChannelArgument?.slice('--release-channel='.length) ?? 'development';

if (apiMode !== 'cloud' && apiMode !== 'local') {
  throw new Error(`Unsupported mini program API mode: ${apiMode}`);
}

if (releaseChannel !== 'development' && releaseChannel !== 'controlled_beta') {
  throw new Error(`Unsupported mini program release channel: ${releaseChannel}`);
}

function requiredPublicMetadata(name) {
  const value = env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing controlled-beta public metadata: ${name}`);
  }
  return value;
}

const releaseMetadata = releaseChannel === 'development'
  ? {
      operatorName: '仅限本地开发，不得发布',
      privacyContact: 'local-only@invalid.example',
      privacyNoticeVersion: 'local-dev'
    }
  : {
      operatorName: requiredPublicMetadata('FITNESS_PUBLIC_OPERATOR_NAME'),
      privacyContact: requiredPublicMetadata('FITNESS_PUBLIC_PRIVACY_CONTACT'),
      privacyNoticeVersion: requiredPublicMetadata('FITNESS_PRIVACY_NOTICE_VERSION')
    };

if (path.dirname(outputRoot) !== buildRoot) {
  throw new Error(`Refusing to clean unexpected output directory: ${outputRoot}`);
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

await build({
  absWorkingDir: repositoryRoot,
  entryPoints: {
    app: 'miniprogram/app.ts',
    'pages/planning-setup/index': 'miniprogram/pages/planning-setup/index.ts',
    'pages/assistant/index': 'miniprogram/pages/assistant/index.ts',
    'pages/planning-preview/index': 'miniprogram/pages/planning-preview/index.ts',
    'pages/meal-execution/index': 'miniprogram/pages/meal-execution/index.ts',
    'pages/ingredient-photo/index': 'miniprogram/pages/ingredient-photo/index.ts',
    'pages/privacy/index': 'miniprogram/pages/privacy/index.ts',
    'pages/data-rights/index': 'miniprogram/pages/data-rights/index.ts'
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  outdir: outputRoot,
  define: {
    __FITNESS_API_MODE__: JSON.stringify(apiMode),
    __FITNESS_RELEASE_CHANNEL__: JSON.stringify(releaseChannel),
    __FITNESS_PUBLIC_OPERATOR_NAME__: JSON.stringify(releaseMetadata.operatorName),
    __FITNESS_PUBLIC_PRIVACY_CONTACT__: JSON.stringify(releaseMetadata.privacyContact),
    __FITNESS_PRIVACY_NOTICE_VERSION__: JSON.stringify(releaseMetadata.privacyNoticeVersion)
  },
  legalComments: 'none',
  minifySyntax: true,
  sourcemap: false
});

const assets = [
  'app.json',
  'app.wxss',
  'sitemap.json',
  'pages/planning-setup/index.json',
  'pages/planning-setup/index.wxml',
  'pages/planning-setup/index.wxss',
  'pages/assistant/index.json',
  'pages/assistant/index.wxml',
  'pages/assistant/index.wxss',
  'pages/planning-preview/index.json',
  'pages/planning-preview/index.wxml',
  'pages/planning-preview/index.wxss',
  'pages/meal-execution/index.json',
  'pages/meal-execution/index.wxml',
  'pages/meal-execution/index.wxss',
  'pages/ingredient-photo/index.json',
  'pages/ingredient-photo/index.wxml',
  'pages/ingredient-photo/index.wxss',
  'pages/privacy/index.json',
  'pages/privacy/index.wxml',
  'pages/privacy/index.wxss',
  'pages/data-rights/index.json',
  'pages/data-rights/index.wxml',
  'pages/data-rights/index.wxss'
];

for (const relativePath of assets) {
  const destination = path.join(outputRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(sourceRoot, relativePath), destination);
}
