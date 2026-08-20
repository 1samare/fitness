import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual, promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseConfiguredServerNames,
  validateControlledBetaMetadata
} from './lib/release-config.mjs';

const execFileAsync = promisify(execFile);
const TRACKED_RELEASE_INPUTS = [
  'cloudbaserc.json',
  'cloudbaserc.photo-cleanup-timer.json',
  'cloudbase/database.rules.json',
  'cloudbase/function.rules.json',
  'cloudbase/storage.rules.json',
  'docs/release/phase-7-release-manifest.json',
  'project.config.json',
  'scripts/build-cloudfunction-deploy.mjs',
  'scripts/build-miniprogram.mjs',
  'scripts/release-preflight.mjs'
];

function safeCheck(name, passed, passedDetail, failedDetail = 'failed') {
  return {
    name,
    status: passed ? 'passed' : 'failed',
    detail: passed ? passedDetail : failedDetail
  };
}

async function readJson(repositoryRoot, relativePath) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), 'utf8'));
}

function expectedFunctions(runtime) {
  return [
    { name: 'planning-api', timeout: 25 },
    { name: 'assistant-api', timeout: 120 },
    { name: 'photo-cleanup', timeout: 25 }
  ].map((entry) => ({
    name: entry.name,
    dir: `./.build/cloudfunctions/${entry.name}`,
    runtime,
    handler: 'index.main',
    timeout: entry.timeout,
    installDependency: false
  }));
}

function validManifest(manifest) {
  return manifest !== null
    && typeof manifest === 'object'
    && manifest.cloudbaseCliVersion === '3.7.2'
    && manifest.nodeRuntime === 'Nodejs20.19'
    && Array.isArray(manifest.functions)
    && isDeepStrictEqual(
      [...manifest.functions].sort(),
      ['assistant-api', 'photo-cleanup', 'planning-api']
    )
    && manifest.reviewedDatasetCollection === 'planning_reviewed_datasets'
    && manifest.userStateCollection === 'planning_user_states'
    && Array.isArray(manifest.requiredServerConfigNames);
}

function validBaseCloudConfig(config, runtime) {
  return isDeepStrictEqual(config, {
    version: '2.0',
    functionRoot: './.build/cloudfunctions',
    functions: expectedFunctions(runtime)
  });
}

function validTimerCloudConfig(config, runtime) {
  const functions = expectedFunctions(runtime).map((entry) => entry.name === 'photo-cleanup'
    ? {
        ...entry,
        triggers: [{
          name: 'photo-cleanup-every-15-minutes',
          type: 'timer',
          config: '0 */15 * * * * *'
        }]
      }
    : entry);
  return isDeepStrictEqual(config, {
    version: '2.0', functionRoot: './.build/cloudfunctions', functions
  });
}

function validDatasetEvidence(evidence, datasetId, now) {
  if (evidence === null || typeof evidence !== 'object') return false;
  const nowTime = Date.parse(now);
  const validatedTime = Date.parse(evidence.validatedAt);
  const expectedHash = createHash('sha256').update(datasetId, 'utf8').digest('hex');
  return evidence.schemaVersion === 'phase-7-dataset-validation-evidence-v1'
    && evidence.status === 'passed'
    && evidence.datasetIdHashSha256 === expectedHash
    && /^[0-9a-f]{64}$/.test(evidence.checksumSha256)
    && typeof evidence.datasetVersion === 'string'
    && evidence.datasetVersion.length > 0
    && Number.isFinite(nowTime)
    && Number.isFinite(validatedTime)
    && validatedTime <= nowTime
    && nowTime - validatedTime <= 24 * 60 * 60 * 1_000;
}

export async function runReleasePreflight({
  repositoryRoot,
  env,
  runCliVersion,
  isTracked
}) {
  const checks = [];
  let manifest;
  try {
    manifest = await readJson(repositoryRoot, 'docs/release/phase-7-release-manifest.json');
    checks.push(safeCheck('Release manifest', validManifest(manifest), 'valid'));
  } catch {
    checks.push(safeCheck('Release manifest', false, 'valid', 'missing'));
  }

  try {
    const privateConfig = await readJson(repositoryRoot, 'project.private.config.json');
    const appId = typeof privateConfig.appid === 'string' ? privateConfig.appid.trim() : '';
    checks.push(safeCheck(
      'AppID', appId.length > 0 && appId !== 'touristappid', 'present', 'missing_or_tourist'
    ));
  } catch {
    checks.push(safeCheck('AppID', false, 'present', 'missing'));
  }

  const environmentPresent = typeof env.FITNESS_CLOUDBASE_ENV_ID === 'string'
    && env.FITNESS_CLOUDBASE_ENV_ID.trim().length > 0;
  checks.push(safeCheck('CloudBase environment', environmentPresent, 'present', 'missing'));

  try {
    validateControlledBetaMetadata(env);
    checks.push(safeCheck('Public privacy metadata', true, 'present'));
  } catch {
    checks.push(safeCheck('Public privacy metadata', false, 'present', 'missing_or_invalid'));
  }

  const datasetId = env.FITNESS_REVIEWED_DATASET_ID?.trim() ?? '';
  checks.push(safeCheck('Reviewed dataset ID', datasetId.length > 0, 'present', 'missing'));

  if (validManifest(manifest)) {
    try {
      const names = parseConfiguredServerNames(env.FITNESS_CLOUDBASE_CONFIGURED_NAMES);
      const complete = manifest.requiredServerConfigNames.every((name) => names.has(name));
      checks.push(safeCheck('Server configuration names', complete, 'complete', 'incomplete'));
    } catch {
      checks.push(safeCheck('Server configuration names', false, 'complete', 'missing_or_invalid'));
    }
  } else {
    checks.push(safeCheck('Server configuration names', false, 'complete', 'manifest_invalid'));
  }

  try {
    const evidence = await readJson(
      repositoryRoot,
      '.build/release-evidence/dataset-validation.json'
    );
    checks.push(safeCheck(
      'Reviewed dataset evidence',
      datasetId.length > 0 && validDatasetEvidence(
        evidence,
        datasetId,
        env.FITNESS_RELEASE_NOW ?? new Date().toISOString()
      ),
      'fresh',
      'missing_stale_or_mismatched'
    ));
  } catch {
    checks.push(safeCheck('Reviewed dataset evidence', false, 'fresh', 'missing'));
  }

  try {
    const version = (await runCliVersion()).trim().replace(/^v/, '');
    const expectedVersion = validManifest(manifest) ? manifest.cloudbaseCliVersion : '3.7.2';
    checks.push(safeCheck(
      'CloudBase CLI', version === expectedVersion, `version ${expectedVersion}`, 'wrong_version'
    ));
  } catch {
    checks.push(safeCheck('CloudBase CLI', false, 'version 3.7.2', 'unavailable'));
  }

  if (validManifest(manifest)) {
    try {
      const base = await readJson(repositoryRoot, 'cloudbaserc.json');
      checks.push(safeCheck(
        'CloudBase function config',
        validBaseCloudConfig(base, manifest.nodeRuntime),
        'matched',
        'drift'
      ));
    } catch {
      checks.push(safeCheck('CloudBase function config', false, 'matched', 'missing'));
    }
    try {
      const timer = await readJson(repositoryRoot, 'cloudbaserc.photo-cleanup-timer.json');
      checks.push(safeCheck(
        'CloudBase timer config',
        validTimerCloudConfig(timer, manifest.nodeRuntime),
        'matched',
        'drift'
      ));
    } catch {
      checks.push(safeCheck('CloudBase timer config', false, 'matched', 'missing'));
    }
  } else {
    checks.push(safeCheck('CloudBase function config', false, 'matched', 'manifest_invalid'));
    checks.push(safeCheck('CloudBase timer config', false, 'matched', 'manifest_invalid'));
  }

  const trackingStates = await Promise.all(TRACKED_RELEASE_INPUTS.map(async (relativePath) => {
    try {
      return await isTracked(relativePath);
    } catch {
      return false;
    }
  }));
  checks.push(safeCheck(
    'Tracked release inputs', trackingStates.every(Boolean), 'complete', 'untracked_or_missing'
  ));

  return {
    schemaVersion: 'phase-7-release-preflight-report-v1',
    status: checks.every((check) => check.status === 'passed') ? 'passed' : 'failed',
    checks
  };
}

export function formatReleasePreflightReport(report) {
  return report.checks.map((check) => `${check.name}: ${check.detail}`).join('\n');
}

async function cliVersion() {
  const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = await execFileAsync(executable, ['exec', 'tcb', '--version'], {
    windowsHide: true,
    timeout: 10_000
  });
  const match = `${result.stdout}\n${result.stderr}`.match(/\b(\d+\.\d+\.\d+)\b/);
  if (match === null) throw new Error('CloudBase CLI version unavailable');
  return match[1];
}

async function tracked(repositoryRoot, relativePath) {
  try {
    await execFileAsync('git', ['ls-files', '--error-unmatch', '--', relativePath], {
      cwd: repositoryRoot,
      windowsHide: true,
      timeout: 5_000
    });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const report = await runReleasePreflight({
    repositoryRoot,
    env: process.env,
    runCliVersion: cliVersion,
    isTracked: (relativePath) => tracked(repositoryRoot, relativePath)
  });
  process.stdout.write(`${formatReleasePreflightReport(report)}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}

const isDirectExecution = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main().catch(() => {
    process.stderr.write('Release preflight: failed (internal_error)\n');
    process.exitCode = 1;
  });
}
