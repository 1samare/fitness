import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(path.join(repositoryRoot, relativePath), 'utf8')) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected an object');
  }
  return value as Record<string, unknown>;
}

describe('CloudBase cleanup deployment boundaries', () => {
  test('keeps the default two-function deployment trigger-free with direct cleanup invocation denied', () => {
    const config = asRecord(readJson('cloudbaserc.json'));
    const functions = config.functions;
    if (!Array.isArray(functions)) throw new Error('Expected functions');
    expect(functions).toEqual([
      expect.objectContaining({ name: 'planning-api' }),
      expect.objectContaining({
        name: 'photo-cleanup',
        dir: './.build/cloudfunctions/photo-cleanup',
        runtime: 'Nodejs20.19',
        handler: 'index.main',
        installDependency: false
      })
    ]);
    for (const functionConfig of functions) {
      expect(asRecord(functionConfig)).not.toHaveProperty('triggers');
    }
    expect(JSON.stringify(config)).not.toContain('disabled');

    const functionRules = asRecord(readJson('cloudbase/function.rules.json'));
    expect(asRecord(functionRules['planning-api']).invoke).toBe('auth != null');
    expect(asRecord(functionRules['photo-cleanup']).invoke).toBe(false);
  });

  test('isolates timer activation in one audited config that changes only the cleanup trigger', () => {
    const activationPath = path.join(repositoryRoot, 'cloudbaserc.photo-cleanup-timer.json');
    expect(existsSync(activationPath)).toBe(true);
    if (!existsSync(activationPath)) return;
    const defaultConfig = asRecord(readJson('cloudbaserc.json'));
    const activationConfig = asRecord(readJson('cloudbaserc.photo-cleanup-timer.json'));
    const defaultFunctions = defaultConfig.functions;
    const activationFunctions = activationConfig.functions;
    if (!Array.isArray(defaultFunctions) || !Array.isArray(activationFunctions)) {
      throw new Error('Expected function arrays');
    }
    expect(activationFunctions).toHaveLength(2);
    expect(activationFunctions[0]).toEqual(defaultFunctions[0]);
    const defaultCleanup = asRecord(defaultFunctions[1]);
    const activationCleanup = asRecord(activationFunctions[1]);
    const { triggers, ...activationCleanupBase } = activationCleanup;
    expect(activationCleanupBase).toEqual(defaultCleanup);
    expect(triggers).toEqual([{
      name: 'photo-cleanup-every-15-minutes',
      type: 'timer',
      config: '0 */15 * * * * *'
    }]);
    expect(JSON.stringify(activationConfig)).not.toContain('disabled');
  });

  test('uses official flat storage rules scoped to authenticated creator-owned photo paths', () => {
    const storageRules = asRecord(readJson('cloudbase/storage.rules.json'));
    const expectedExpression = 'auth != null && /^ingredient-photos\\//.test(resource.path) == true && resource.openid == auth.openid';
    expect(storageRules).toEqual({
      read: expectedExpression,
      write: expectedExpression
    });
    expect(storageRules).not.toHaveProperty('rules');
    expect(JSON.stringify(storageRules)).not.toContain('resource.creator');
  });

  test('builds an explicit isolated two-function allowlist without maps, fixtures, links, or stale functions', () => {
    const executable = process.platform === 'win32' ? 'cmd.exe' : 'pnpm';
    const commandArguments = (workspace: string): readonly string[] => process.platform === 'win32'
      ? ['/d', '/s', '/c', `pnpm.cmd --filter ${workspace} build`]
      : ['--filter', workspace, 'build'];
    execFileSync(executable, commandArguments('@fitness/planning-api'), {
      cwd: repositoryRoot,
      stdio: 'pipe'
    });
    execFileSync(executable, commandArguments('@fitness/photo-cleanup'), {
      cwd: repositoryRoot,
      stdio: 'pipe'
    });
    const staleDirectory = path.join(repositoryRoot, '.build', 'cloudfunctions', 'unrelated-function');
    mkdirSync(staleDirectory, { recursive: true });
    writeFileSync(path.join(staleDirectory, 'index.js'), 'stale', 'utf8');

    execFileSync(process.execPath, [path.join(repositoryRoot, 'scripts', 'build-cloudfunction-deploy.mjs')], {
      cwd: repositoryRoot,
      stdio: 'pipe'
    });

    const buildRoot = path.join(repositoryRoot, '.build', 'cloudfunctions');
    expect(readdirSync(buildRoot).sort()).toEqual(['photo-cleanup', 'planning-api']);
    const forbiddenFixtureSentinels = [
      'TEST_INGREDIENT_VISION_RESPONSE',
      'TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS',
      'fixture-vision-request-v1',
      'FITNESS-TEST-FIXTURE-V2',
      'fixture-2026-08-10',
      'FITNESS_RUNTIME_MODE',
      'FITNESS_LOCAL_USER_ID'
    ];
    for (const functionName of ['photo-cleanup', 'planning-api']) {
      const directory = path.join(buildRoot, functionName);
      expect(readdirSync(directory).sort()).toEqual(['index.js', 'package.json']);
      for (const entry of readdirSync(directory)) {
        const stats = lstatSync(path.join(directory, entry));
        expect(stats.isSymbolicLink()).toBe(false);
        expect(entry.endsWith('.map')).toBe(false);
        expect(entry.includes('fixture')).toBe(false);
      }
      const entryPath = path.join(directory, 'index.js');
      expect(existsSync(entryPath)).toBe(true);
      const bundledSource = readFileSync(entryPath, 'utf8');
      expect(forbiddenFixtureSentinels.filter((sentinel) => bundledSource.includes(sentinel)))
        .toEqual([]);
    }
  }, 30_000);
});
