import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import {
  createReviewedDatasetEvidence,
  writeReviewedDatasetEvidence
} from './lib/reviewed-dataset-evidence.mjs';

async function loadBuiltValidator() {
  const bundleDirectory = path.resolve('.build', 'release-tools');
  const bundlePath = path.join(bundleDirectory, 'reviewed-dataset-validator.mjs');
  await mkdir(bundleDirectory, { recursive: true });
  await build({
    entryPoints: [path.resolve('packages/providers/src/reviewed-planning-dataset-validator.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    logLevel: 'silent',
    sourcemap: false
  });
  const providers = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);
  if (typeof providers.validateReviewedPlanningDataset !== 'function') {
    throw new Error('Reviewed dataset validator is unavailable');
  }
  return providers.validateReviewedPlanningDataset;
}

export async function validateDatasetFile({
  inputPath,
  evidenceDirectory,
  now,
  validate = undefined
}) {
  if (!path.isAbsolute(inputPath)) {
    throw new Error('FITNESS_REVIEWED_DATASET_FILE must be an absolute path');
  }
  const validateCandidate = validate ?? await loadBuiltValidator();
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  const dataset = validateCandidate(input, now);
  const evidence = createReviewedDatasetEvidence(dataset, now);
  await writeReviewedDatasetEvidence(evidenceDirectory, evidence);
  return evidence;
}

async function main() {
  const inputPath = process.env.FITNESS_REVIEWED_DATASET_FILE;
  if (typeof inputPath !== 'string' || inputPath.trim().length === 0) {
    throw new Error('FITNESS_REVIEWED_DATASET_FILE: missing');
  }
  const now = process.env.FITNESS_RELEASE_NOW ?? new Date().toISOString();
  await validateDatasetFile({
    inputPath,
    evidenceDirectory: path.resolve('.build', 'release-evidence'),
    now
  });
  process.stdout.write('Reviewed dataset validation: passed\n');
}

const isDirectExecution = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main().catch((error) => {
    const status = error instanceof Error ? error.name : 'unknown_error';
    process.stderr.write(`Reviewed dataset validation: failed (${status})\n`);
    process.exitCode = 1;
  });
}
