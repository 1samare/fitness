import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DATASET_EVIDENCE_FILE_NAME = 'dataset-validation.json';

export function createReviewedDatasetEvidence(dataset, validatedAt) {
  return {
    schemaVersion: 'phase-7-dataset-validation-evidence-v1',
    datasetIdHashSha256: createHash('sha256').update(dataset.datasetId, 'utf8').digest('hex'),
    datasetVersion: dataset.datasetVersion,
    checksumSha256: dataset.checksumSha256,
    recordCounts: {
      nutritionSnapshots: dataset.nutritionSnapshots.length,
      recipeTemplates: dataset.recipeTemplates.length,
      dailyMenus: dataset.dailyMenus.length
    },
    validatedAt,
    status: 'passed'
  };
}

export async function writeReviewedDatasetEvidence(evidenceDirectory, evidence) {
  const resolvedDirectory = path.resolve(evidenceDirectory);
  await mkdir(resolvedDirectory, { recursive: true });
  const targetPath = path.join(resolvedDirectory, DATASET_EVIDENCE_FILE_NAME);
  const temporaryPath = path.join(
    resolvedDirectory,
    `.${DATASET_EVIDENCE_FILE_NAME}.${randomUUID()}.tmp`
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx'
    });
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return targetPath;
}
