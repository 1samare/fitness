import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(repositoryRoot, 'miniprogram');
const buildRoot = path.join(repositoryRoot, '.build');
const outputRoot = path.join(buildRoot, 'miniprogram');
const apiModeArgument = argv.find((argument) => argument.startsWith('--api-mode='));
const apiMode = apiModeArgument?.slice('--api-mode='.length) ?? 'cloud';

if (apiMode !== 'cloud' && apiMode !== 'local') {
  throw new Error(`Unsupported mini program API mode: ${apiMode}`);
}

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
    'pages/planning-preview/index': 'miniprogram/pages/planning-preview/index.ts'
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  outdir: outputRoot,
  define: {
    __FITNESS_API_MODE__: JSON.stringify(apiMode)
  },
  legalComments: 'none',
  sourcemap: false
});

const assets = [
  'app.json',
  'app.wxss',
  'sitemap.json',
  'pages/planning-setup/index.json',
  'pages/planning-setup/index.wxml',
  'pages/planning-setup/index.wxss',
  'pages/planning-preview/index.json',
  'pages/planning-preview/index.wxml',
  'pages/planning-preview/index.wxss'
];

for (const relativePath of assets) {
  const destination = path.join(outputRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(sourceRoot, relativePath), destination);
}
