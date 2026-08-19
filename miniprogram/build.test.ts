import { execFile } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';

const execFileAsync = promisify(execFile);

describe('mini program production build', () => {
  test('emits the registered ingredient photo page without source-only files', async () => {
    await execFileAsync(process.execPath, [
      'scripts/build-miniprogram.mjs', '--api-mode=cloud'
    ], { cwd: new URL('..', import.meta.url), windowsHide: true });

    const pageRoot = new URL('../.build/miniprogram/pages/ingredient-photo/', import.meta.url);
    for (const filename of ['index.js', 'index.json', 'index.wxml', 'index.wxss']) {
      await expect(access(new URL(filename, pageRoot))).resolves.toBeUndefined();
    }
    const emitted = await readdir(pageRoot);
    expect(emitted.some((filename) => /\.(?:ts|test\.|fixture)/.test(filename))).toBe(false);
    const javascript = await readFile(new URL('index.js', pageRoot), 'utf8');
    expect(javascript).not.toContain('local-private-photo.jpg');
    expect(javascript).not.toContain('cloud://sensitive');
  });
});
