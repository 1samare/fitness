import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { validateCapacityResult } from './release-capacity.mjs';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'fitness-capacity-evidence-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

function passingResult() {
  return {
    schemaVersion: 'phase-7-capacity-raw-v1',
    mode: 'local_baseline',
    identityLabels: Array.from({ length: 10 }, (_, index) => (
      `tester-${String(index + 1).padStart(2, '0')}`
    )),
    identityCount: 10,
    operationsPerIdentity: 30,
    totalOperations: 300,
    planningSuccessRate: 1,
    providerBoundedOutcomeRate: 1,
    p95LatencyMs: 4999,
    crossUserLeakCount: 0,
    partialTransactionCount: 0,
    duplicateEffectiveVersionCount: 0,
    lostCleanupCount: 0,
    providerTimeoutViolationCount: 0,
    quotaViolationCount: 0,
    budgetExceeded: false,
    status: 'passed'
  };
}

describe('capacity evidence validation', () => {
  test('hashes identity labels and writes only passing aggregate evidence', async () => {
    const directory = await temporaryDirectory();
    const inputPath = path.join(directory, 'local-result.json');
    const evidenceDirectory = path.join(directory, 'evidence');
    await writeFile(inputPath, JSON.stringify(passingResult()), 'utf8');
    const evidence = await validateCapacityResult({ inputPath, evidenceDirectory });
    expect(evidence).toMatchObject({
      schemaVersion: 'phase-7-capacity-evidence-v1',
      mode: 'local_baseline',
      totalOperations: 300,
      status: 'passed'
    });
    expect(evidence.identityLabelHashesSha256).toHaveLength(10);
    const persisted = await readFile(path.join(evidenceDirectory, 'capacity-validation.json'), 'utf8');
    expect(persisted).not.toContain('tester-01');
  });

  test.each([
    ['missing identity', (value: ReturnType<typeof passingResult>) => { value.identityLabels.pop(); }],
    ['299 operations', (value: ReturnType<typeof passingResult>) => { value.totalOperations = 299; }],
    ['5000 ms p95', (value: ReturnType<typeof passingResult>) => { value.p95LatencyMs = 5000; }],
    ['99.9% planning', (value: ReturnType<typeof passingResult>) => { value.planningSuccessRate = 0.999; }],
    ['provider unbounded', (value: ReturnType<typeof passingResult>) => { value.providerBoundedOutcomeRate = 0.999; }],
    ['partial transaction', (value: ReturnType<typeof passingResult>) => { value.partialTransactionCount = 1; }],
    ['cross leak', (value: ReturnType<typeof passingResult>) => { value.crossUserLeakCount = 1; }],
    ['duplicate effective version', (value: ReturnType<typeof passingResult>) => { value.duplicateEffectiveVersionCount = 1; }],
    ['lost cleanup', (value: ReturnType<typeof passingResult>) => { value.lostCleanupCount = 1; }],
    ['provider timeout', (value: ReturnType<typeof passingResult>) => { value.providerTimeoutViolationCount = 1; }],
    ['quota violation', (value: ReturnType<typeof passingResult>) => { value.quotaViolationCount = 1; }],
    ['budget excess', (value: ReturnType<typeof passingResult>) => { value.budgetExceeded = true; }]
  ])('rejects %s', async (_name, mutate) => {
    const directory = await temporaryDirectory();
    const inputPath = path.join(directory, 'result.json');
    const value = passingResult();
    mutate(value);
    await writeFile(inputPath, JSON.stringify(value), 'utf8');
    await expect(validateCapacityResult({ inputPath, evidenceDirectory: directory }))
      .rejects.toThrow();
  });

  test('rejects raw OpenID-shaped values anywhere in input', async () => {
    const directory = await temporaryDirectory();
    const inputPath = path.join(directory, 'result.json');
    await writeFile(inputPath, JSON.stringify({
      ...passingResult(),
      unexpected: 'o1234567890123456789012345678'
    }), 'utf8');
    await expect(validateCapacityResult({ inputPath, evidenceDirectory: directory }))
      .rejects.toThrow();
  });
});
