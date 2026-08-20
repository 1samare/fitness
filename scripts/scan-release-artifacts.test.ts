import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { scanReleaseArtifacts } from './scan-release-artifacts.mjs';

const temporaryDirectories: string[] = [];

async function write(root: string, relativePath: string, value: string): Promise<void> {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, value, 'utf8');
}

async function cleanBuild(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'fitness-artifact-scan-'));
  temporaryDirectories.push(root);
  for (const functionName of ['planning-api', 'assistant-api', 'photo-cleanup']) {
    await write(root, `.build/cloudfunctions/${functionName}/index.js`, 'export const main = () => {};');
    await write(root, `.build/cloudfunctions/${functionName}/package.json`, '{"main":"index.js"}');
  }
  await write(root, '.build/miniprogram/app.js', [
    'const snapshotToken = input.snapshotToken;',
    'const estimatedTokenUnits = 1;',
    'const CLOUDBASE_STORAGE_FILE_ID_PREFIX = "name-only";',
    'const cloudPrefixValidator = "cloud://";'
  ].join('\n'));
  await write(root, '.build/miniprogram/app.json', '{}');
  await write(root, '.build/release-evidence/dataset-validation.json', JSON.stringify({
    schemaVersion: 'phase-7-dataset-validation-evidence-v1',
    datasetIdHashSha256: 'a'.repeat(64),
    checksumSha256: 'b'.repeat(64),
    status: 'passed'
  }));
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('release artifact scanner', () => {
  test('accepts only the three function allowlists plus a safe mini program/evidence tree', async () => {
    const report = await scanReleaseArtifacts({ repositoryRoot: await cleanBuild() });
    expect(report).toEqual({ status: 'passed', findings: [] });
  });

  test.each([
    ['source-map', '.build/cloudfunctions/planning-api/index.js.map', '{}'],
    ['test-file', '.build/miniprogram/page.test.js', 'test'],
    ['node-modules', '.build/miniprogram/node_modules/x.js', 'x'],
    ['fixture-marker', '.build/miniprogram/app.js', 'FITNESS-TEST-FIXTURE-V2'],
    ['openid-value', '.build/release-evidence/log.json', '{"openid":"o1234567890123456789012345678"}'],
    ['base64-image', '.build/release-evidence/log.json', '{"image":"data:image/jpeg;base64,AAAA"}'],
    ['cloud-file-id', '.build/release-evidence/log.json', '{"file":"cloud://bucket/user/photo.jpg"}'],
    ['secret-value', '.build/cloudfunctions/planning-api/index.js', 'const secret="abcdefghijklmnopqrstuvwxyz123456";'],
    ['extra-function', '.build/cloudfunctions/unapproved/index.js', 'x']
  ])('rejects %s', async (_name, relativePath, value) => {
    const root = await cleanBuild();
    await write(root, relativePath, value);
    const report = await scanReleaseArtifacts({ repositoryRoot: root });
    expect(report.status).toBe('failed');
    expect(report.findings[0]).toEqual(expect.objectContaining({
      path: relativePath.replaceAll('\\', '/'),
      ruleId: expect.any(String)
    }));
    if (value.length > 20) expect(JSON.stringify(report.findings)).not.toContain(value);
  });

  test.skipIf(process.platform === 'win32')('rejects symbolic links without following them', async () => {
    const root = await cleanBuild();
    const target = path.join(root, '.build', 'miniprogram', 'linked.js');
    await symlink(path.join(root, '.build', 'miniprogram', 'app.js'), target);
    const report = await scanReleaseArtifacts({ repositoryRoot: root });
    expect(report).toMatchObject({ status: 'failed' });
    expect(report.findings).toContainEqual(expect.objectContaining({ ruleId: 'symbolic_link' }));
  });
});
