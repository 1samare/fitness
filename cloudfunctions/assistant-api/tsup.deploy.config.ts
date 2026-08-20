import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/deploy-index.ts' },
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist/deploy',
  clean: true,
  sourcemap: false,
  minify: false,
  noExternal: [/.*/]
});
