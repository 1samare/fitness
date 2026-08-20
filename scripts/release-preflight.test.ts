import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  formatReleasePreflightReport,
  runReleasePreflight
} from './release-preflight.mjs';

const temporaryDirectories: string[] = [];
const NOW = '2026-08-20T12:00:00.000Z';
const DATASET_ID = 'dataset-secret-sentinel';
const requiredNames = [
  'CLOUDBASE_STORAGE_FILE_ID_PREFIX',
  'FITNESS_VISION_FUNCTION_NAME',
  'CLOUDBASE_ENV_ID',
  'FITNESS_LLM_PROVIDER_ID',
  'FITNESS_LLM_MODEL',
  'FITNESS_REVIEWED_DATASET_ID'
];

const functions = [
  { name: 'planning-api', timeout: 25 },
  { name: 'assistant-api', timeout: 120 },
  { name: 'photo-cleanup', timeout: 25 }
].map((value) => ({
  ...value,
  dir: `./.build/cloudfunctions/${value.name}`,
  runtime: 'Nodejs20.19',
  handler: 'index.main',
  installDependency: false
}));

async function writeJson(root: string, relativePath: string, value: unknown): Promise<void> {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function validRepository() {
  const root = await mkdtemp(path.join(tmpdir(), 'fitness-release-preflight-'));
  temporaryDirectories.push(root);
  await writeJson(root, 'project.config.json', { appid: 'touristappid' });
  await writeJson(root, 'project.private.config.json', { appid: 'wx-real-appid-sentinel' });
  await writeJson(root, 'cloudbaserc.json', {
    version: '2.0', functionRoot: './.build/cloudfunctions', functions
  });
  await writeJson(root, 'cloudbaserc.photo-cleanup-timer.json', {
    version: '2.0',
    functionRoot: './.build/cloudfunctions',
    functions: functions.map((entry) => entry.name === 'photo-cleanup' ? {
      ...entry,
      triggers: [{
        name: 'photo-cleanup-every-15-minutes',
        type: 'timer',
        config: '0 */15 * * * * *'
      }]
    } : entry)
  });
  await writeJson(root, 'cloudbase/database.rules.json', { read: false, write: false });
  await writeJson(root, 'cloudbase/function.rules.json', {
    '*': { invoke: false },
    'planning-api': { invoke: 'auth != null' },
    'assistant-api': { invoke: 'auth != null' },
    'photo-cleanup': { invoke: false }
  });
  await writeJson(root, 'cloudbase/storage.rules.json', { read: false, write: false });
  await writeJson(root, 'docs/release/phase-7-release-manifest.json', {
    cloudbaseCliVersion: '3.7.2',
    nodeRuntime: 'Nodejs20.19',
    functions: ['photo-cleanup', 'planning-api', 'assistant-api'],
    reviewedDatasetCollection: 'planning_reviewed_datasets',
    userStateCollection: 'planning_user_states',
    requiredServerConfigNames: requiredNames
  });
  await writeJson(root, '.build/release-evidence/dataset-validation.json', {
    schemaVersion: 'phase-7-dataset-validation-evidence-v1',
    datasetIdHashSha256: createHash('sha256').update(DATASET_ID).digest('hex'),
    datasetVersion: 'reviewed-2026-08-20',
    checksumSha256: 'a'.repeat(64),
    recordCounts: { nutritionSnapshots: 3, recipeTemplates: 3, dailyMenus: 7 },
    validatedAt: '2026-08-20T11:30:00.000Z',
    status: 'passed'
  });
  return root;
}

function validEnvironment(): Record<string, string> {
  return {
    FITNESS_RELEASE_NOW: NOW,
    FITNESS_CLOUDBASE_ENV_ID: 'env-secret-sentinel',
    FITNESS_PUBLIC_OPERATOR_NAME: '运营主体 sentinel',
    FITNESS_PUBLIC_PRIVACY_CONTACT: 'privacy-contact-sentinel@example.test',
    FITNESS_PRIVACY_NOTICE_VERSION: 'beta-2026-08-20',
    FITNESS_REVIEWED_DATASET_ID: DATASET_ID,
    FITNESS_CLOUDBASE_CONFIGURED_NAMES: requiredNames.join(',')
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function run(root: string, overrides: {
  env?: Record<string, string>;
  cliVersion?: string;
  isTracked?: (relativePath: string) => boolean;
} = {}) {
  return runReleasePreflight({
    repositoryRoot: root,
    env: overrides.env ?? validEnvironment(),
    runCliVersion: () => Promise.resolve(overrides.cliVersion ?? '3.7.2'),
    isTracked: overrides.isTracked ?? (() => Promise.resolve(true))
  });
}

describe('release preflight', () => {
  test('passes valid inputs while formatting only names, presence and versions', async () => {
    const report = await run(await validRepository());
    const text = formatReleasePreflightReport(report);
    expect(report.status).toBe('passed');
    expect(text).toContain('AppID: present');
    expect(text).toContain('CloudBase CLI: version 3.7.2');
    for (const sentinel of [
      'wx-real-appid-sentinel',
      'env-secret-sentinel',
      'privacy-contact-sentinel',
      DATASET_ID
    ]) expect(text).not.toContain(sentinel);
  });

  test('fails absent/tourist AppID and absent target environment selection', async () => {
    const root = await validRepository();
    await writeJson(root, 'project.private.config.json', { appid: 'touristappid' });
    expect((await run(root)).status).toBe('failed');
    const missingEnv = validEnvironment();
    delete missingEnv.FITNESS_CLOUDBASE_ENV_ID;
    expect((await run(root, { env: missingEnv })).status).toBe('failed');
  });

  test('fails local metadata, missing/stale dataset evidence and wrong CLI version', async () => {
    const root = await validRepository();
    const local = validEnvironment();
    local.FITNESS_PUBLIC_OPERATOR_NAME = '仅限本地开发，不得发布';
    expect((await run(root, { env: local })).status).toBe('failed');
    await writeJson(root, '.build/release-evidence/dataset-validation.json', {
      status: 'passed', validatedAt: '2026-08-18T00:00:00.000Z'
    });
    expect((await run(root)).status).toBe('failed');
    expect((await run(root, { cliVersion: '3.7.1' })).status).toBe('failed');
  });

  test('fails missing server names, CloudBase drift, timer drift and untracked inputs', async () => {
    const root = await validRepository();
    const missingName = validEnvironment();
    missingName.FITNESS_CLOUDBASE_CONFIGURED_NAMES = requiredNames.slice(1).join(',');
    expect((await run(root, { env: missingName })).status).toBe('failed');

    await writeJson(root, 'cloudbaserc.json', {
      version: '2.0',
      functionRoot: './.build/cloudfunctions',
      functions: functions.map((entry) => entry.name === 'planning-api'
        ? { ...entry, runtime: 'Nodejs18.15' }
        : entry)
    });
    expect((await run(root)).status).toBe('failed');

    const repaired = await validRepository();
    await writeJson(repaired, 'cloudbaserc.photo-cleanup-timer.json', {
      version: '2.0', functionRoot: './.build/cloudfunctions', functions
    });
    expect((await run(repaired)).status).toBe('failed');
    expect((await run(repaired, {
      isTracked: (relativePath) => relativePath !== 'cloudbaserc.json'
    })).status).toBe('failed');
  });
});
