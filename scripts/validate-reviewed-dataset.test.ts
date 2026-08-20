import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  createReviewedPlanningDatasetCandidate,
  REVIEWED_DATASET_NOW
} from '../packages/providers/src/reviewed-planning-dataset.test-support';
import {
  canonicalReviewedDatasetPayload,
  validateReviewedPlanningDataset
} from '../packages/providers/src/reviewed-planning-dataset-validator';
import { validateDatasetFile } from './validate-reviewed-dataset.mjs';

const temporaryDirectories: string[] = [];

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label} test fixture`);
  return value;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'fitness-reviewed-dataset-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

function validDataset() {
  const candidate = createReviewedPlanningDatasetCandidate();
  candidate.checksumSha256 = createHash('sha256')
    .update(canonicalReviewedDatasetPayload(candidate), 'utf8')
    .digest('hex');
  return candidate;
}

describe('validateDatasetFile', () => {
  test('writes only anonymized passing evidence for a valid private candidate', async () => {
    const directory = await temporaryDirectory();
    const inputPath = path.join(directory, 'private-candidate.json');
    const evidenceDirectory = path.join(directory, '.build', 'release-evidence');
    await writeFile(inputPath, JSON.stringify(validDataset()), 'utf8');

    const evidence = await validateDatasetFile({
      inputPath,
      evidenceDirectory,
      now: REVIEWED_DATASET_NOW
    });
    const persisted = JSON.parse(await readFile(
      path.join(evidenceDirectory, 'dataset-validation.json'),
      'utf8'
    )) as Record<string, unknown>;

    expect(persisted).toEqual(evidence);
    expect(Object.keys(persisted).sort()).toEqual([
      'checksumSha256',
      'datasetIdHashSha256',
      'datasetVersion',
      'recordCounts',
      'schemaVersion',
      'status',
      'validatedAt'
    ]);
    expect(persisted).toMatchObject({
      schemaVersion: 'phase-7-dataset-validation-evidence-v1',
      datasetVersion: 'reviewed-2026-08-20',
      checksumSha256: validDataset().checksumSha256,
      status: 'passed',
      validatedAt: REVIEWED_DATASET_NOW,
      recordCounts: { nutritionSnapshots: 3, recipeTemplates: 3, dailyMenus: 7 }
    });
    expect(persisted.datasetIdHashSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(persisted)).not.toContain('reviewed-planning-cn-v1');
    expect(JSON.stringify(persisted)).not.toContain('private-candidate');
  }, 15_000);

  test('invalid input rejects and never replaces prior passing evidence', async () => {
    const directory = await temporaryDirectory();
    const inputPath = path.join(directory, 'candidate.json');
    const evidenceDirectory = path.join(directory, 'evidence');
    await writeFile(inputPath, JSON.stringify(validDataset()), 'utf8');
    await validateDatasetFile({
      inputPath,
      evidenceDirectory,
      now: REVIEWED_DATASET_NOW,
      validate: validateReviewedPlanningDataset
    });
    const before = await readFile(path.join(evidenceDirectory, 'dataset-validation.json'), 'utf8');

    const invalid = validDataset();
    const menu = required(invalid.dailyMenus[0], 'daily menu');
    required(menu.meals[0], 'daily menu meal').recipeTemplateVersionId = 'missing-recipe';
    await writeFile(inputPath, JSON.stringify(invalid), 'utf8');

    await expect(validateDatasetFile({
      inputPath,
      evidenceDirectory,
      now: REVIEWED_DATASET_NOW,
      validate: validateReviewedPlanningDataset
    }))
      .rejects.toThrow();
    await expect(readFile(path.join(evidenceDirectory, 'dataset-validation.json'), 'utf8'))
      .resolves.toBe(before);
  });
});
