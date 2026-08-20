import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function invalid() {
  throw new Error('Capacity result failed validation');
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateRaw(value, serialized) {
  if (/(?:"openid"\s*:|\bo[A-Za-z0-9_-]{27,}\b)/i.test(serialized)) invalid();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const expectedLabels = Array.from({ length: 10 }, (_, index) => (
    `tester-${String(index + 1).padStart(2, '0')}`
  ));
  if (
    value.schemaVersion !== 'phase-7-capacity-raw-v1'
    || !['local_baseline', 'cloud_controlled_beta'].includes(value.mode)
    || !Array.isArray(value.identityLabels)
    || JSON.stringify(value.identityLabels) !== JSON.stringify(expectedLabels)
    || value.identityCount !== 10
    || value.operationsPerIdentity !== 30
    || value.totalOperations !== 300
    || value.planningSuccessRate !== 1
    || value.providerBoundedOutcomeRate !== 1
    || !finiteNumber(value.p95LatencyMs)
    || value.p95LatencyMs < 0
    || value.p95LatencyMs >= 5_000
    || value.crossUserLeakCount !== 0
    || value.partialTransactionCount !== 0
    || value.duplicateEffectiveVersionCount !== 0
    || value.lostCleanupCount !== 0
    || value.providerTimeoutViolationCount !== 0
    || value.quotaViolationCount !== 0
    || value.budgetExceeded !== false
    || value.status !== 'passed'
  ) invalid();
  return value;
}

async function writeAtomic(evidenceDirectory, evidence) {
  await mkdir(evidenceDirectory, { recursive: true });
  const target = path.join(evidenceDirectory, 'capacity-validation.json');
  const temporary = path.join(evidenceDirectory, `.capacity-validation.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function validateCapacityResult({ inputPath, evidenceDirectory }) {
  const serialized = await readFile(inputPath, 'utf8');
  const value = validateRaw(JSON.parse(serialized), serialized);
  const evidence = {
    schemaVersion: 'phase-7-capacity-evidence-v1',
    mode: value.mode,
    identityLabelHashesSha256: value.identityLabels.map((label) => (
      createHash('sha256').update(label, 'utf8').digest('hex')
    )),
    identityCount: value.identityCount,
    operationsPerIdentity: value.operationsPerIdentity,
    totalOperations: value.totalOperations,
    planningSuccessRate: value.planningSuccessRate,
    providerBoundedOutcomeRate: value.providerBoundedOutcomeRate,
    p95LatencyMs: value.p95LatencyMs,
    crossUserLeakCount: value.crossUserLeakCount,
    partialTransactionCount: value.partialTransactionCount,
    duplicateEffectiveVersionCount: value.duplicateEffectiveVersionCount,
    lostCleanupCount: value.lostCleanupCount,
    providerTimeoutViolationCount: value.providerTimeoutViolationCount,
    quotaViolationCount: value.quotaViolationCount,
    budgetExceeded: value.budgetExceeded,
    status: 'passed'
  };
  await writeAtomic(evidenceDirectory, evidence);
  return evidence;
}

async function main() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cloudInput = process.env.FITNESS_CLOUD_CAPACITY_INPUT_FILE?.trim();
  const inputPath = cloudInput === undefined || cloudInput.length === 0
    ? path.join(repositoryRoot, '.build', 'release-capacity', 'local-result.json')
    : path.resolve(cloudInput);
  await validateCapacityResult({
    inputPath,
    evidenceDirectory: path.join(repositoryRoot, '.build', 'release-evidence')
  });
  process.stdout.write('Capacity validation: passed\n');
}

const isDirectExecution = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main().catch(() => {
    process.stderr.write('Capacity validation: failed\n');
    process.exitCode = 1;
  });
}
