import { execFile } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';

const execFileAsync = promisify(execFile);

describe('mini program production build', () => {
  test('emits all registered interactive and privacy pages without source-only files', async () => {
    await execFileAsync(process.execPath, [
      'scripts/build-miniprogram.mjs', '--api-mode=cloud', '--release-channel=development'
    ], { cwd: new URL('..', import.meta.url), windowsHide: true });

    for (const pageName of ['assistant', 'ingredient-photo', 'privacy', 'data-rights']) {
      const pageRoot = new URL(`../.build/miniprogram/pages/${pageName}/`, import.meta.url);
      for (const filename of ['index.js', 'index.json', 'index.wxml', 'index.wxss']) {
        await expect(access(new URL(filename, pageRoot))).resolves.toBeUndefined();
      }
      const emitted = await readdir(pageRoot);
      expect(emitted.some((filename) => /\.(?:ts|test\.|fixture)/.test(filename))).toBe(false);
    }
    const ingredientPhotoRoot = new URL(
      '../.build/miniprogram/pages/ingredient-photo/', import.meta.url
    );
    const javascript = await readFile(new URL('index.js', ingredientPhotoRoot), 'utf8');
    expect(javascript).not.toContain('local-private-photo.jpg');
    expect(javascript).not.toContain('cloud://sensitive');
    const assistantJavascript = await readFile(
      new URL('../.build/miniprogram/pages/assistant/index.js', import.meta.url), 'utf8'
    );
    expect(assistantJavascript).not.toMatch(/FITNESS_LLM_PROVIDER_ID|FITNESS_LLM_MODEL/);
  });

  test('injects controlled-beta public metadata without development contact values', async () => {
    await execFileAsync(process.execPath, [
      'scripts/build-miniprogram.mjs',
      '--api-mode=cloud',
      '--release-channel=controlled_beta'
    ], {
      cwd: new URL('..', import.meta.url),
      windowsHide: true,
      env: {
        ...process.env,
        FITNESS_PUBLIC_OPERATOR_NAME: '测试运营主体',
        FITNESS_PUBLIC_PRIVACY_CONTACT: 'privacy@example.test',
        FITNESS_PRIVACY_NOTICE_VERSION: 'beta-2026-08-20'
      }
    });
    const privacyJavascript = await readFile(
      new URL('../.build/miniprogram/pages/privacy/index.js', import.meta.url),
      'utf8'
    );
    expect(privacyJavascript).toMatch(/\\u6D4B\\u8BD5\\u8FD0\\u8425\\u4E3B\\u4F53/i);
    expect(privacyJavascript).toContain('privacy@example.test');
    expect(privacyJavascript).toContain('beta-2026-08-20');
    expect(privacyJavascript).not.toContain('local-only@invalid.example');
  });

  test('fails a controlled-beta build when any public metadata value is empty', async () => {
    const environment = { ...process.env };
    delete environment.FITNESS_PUBLIC_OPERATOR_NAME;
    delete environment.FITNESS_PUBLIC_PRIVACY_CONTACT;
    delete environment.FITNESS_PRIVACY_NOTICE_VERSION;

    await expect(execFileAsync(process.execPath, [
      'scripts/build-miniprogram.mjs',
      '--api-mode=cloud',
      '--release-channel=controlled_beta'
    ], {
      cwd: new URL('..', import.meta.url),
      windowsHide: true,
      env: environment
    })).rejects.toThrow('FITNESS_PUBLIC_OPERATOR_NAME: missing');
  });

  test('rejects development-only metadata in a controlled-beta artifact', async () => {
    await expect(execFileAsync(process.execPath, [
      'scripts/build-miniprogram.mjs',
      '--api-mode=cloud',
      '--release-channel=controlled_beta'
    ], {
      cwd: new URL('..', import.meta.url),
      windowsHide: true,
      env: {
        ...process.env,
        FITNESS_PUBLIC_OPERATOR_NAME: '仅限本地开发，不得发布',
        FITNESS_PUBLIC_PRIVACY_CONTACT: 'local-only@invalid.example',
        FITNESS_PRIVACY_NOTICE_VERSION: 'local-dev'
      }
    })).rejects.toThrow('development-only values');
  });
});
