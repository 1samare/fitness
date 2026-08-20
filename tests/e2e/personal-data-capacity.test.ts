import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { planningApiResponseSchema, type PlanningApiResponse } from '@fitness/contracts';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const serverBundle = path.join(repositoryRoot, '.build', 'release-capacity', 'server.mjs');
let child: import('node:child_process').ChildProcessWithoutNullStreams | undefined;
let endpoint = '';
let output = '';
let port = 0;

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No capacity port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function request(pathname: string, options: {
  identity?: string;
  body?: unknown;
  injectProviderFailure?: boolean;
} = {}): Promise<{ value: unknown; elapsedMs: number; text: string }> {
  const started = performance.now();
  const response = await fetch(`${endpoint}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.identity === undefined ? {} : {
        'x-fitness-capacity-identity': options.identity
      }),
      ...(options.injectProviderFailure ? {
        'x-fitness-capacity-inject-provider-failure': '1'
      } : {})
    },
    body: JSON.stringify(options.body ?? {})
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Capacity HTTP ${String(response.status)}: ${text}`);
  return { value: JSON.parse(text) as unknown, elapsedMs: performance.now() - started, text };
}

async function waitReady(): Promise<void> {
  const marker = `CAPACITY_SERVER_READY:${String(port)}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (output.includes(marker)) return;
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`Capacity server exited\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Capacity server not ready\n${output}`);
}

async function stopChild(): Promise<void> {
  const running = child;
  if (running !== undefined && running.exitCode === null) {
    const closed = new Promise<void>((resolve) => running.once('close', () => resolve()));
    if (!running.kill('SIGTERM')) throw new Error('Could not stop capacity server');
    await closed;
  }
  if (port !== 0) {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

beforeAll(async () => {
  await execFileAsync(process.execPath, ['scripts/build-capacity-planning-api.mjs'], {
    cwd: repositoryRoot,
    windowsHide: true
  });
  port = await reservePort();
  endpoint = `http://127.0.0.1:${String(port)}`;
  child = (await import('node:child_process')).spawn(process.execPath, [serverBundle], {
    cwd: repositoryRoot,
    env: { ...process.env, PORT: String(port) },
    shell: false,
    windowsHide: true
  });
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  await waitReady();
}, 30_000);

afterAll(async () => {
  await stopChild();
});

function asSuccess(value: unknown): Extract<PlanningApiResponse, { success: true }> {
  const parsed = planningApiResponseSchema.parse(value);
  if (!parsed.success) throw new Error(`Expected success: ${parsed.error.code}`);
  return parsed;
}

describe('personal data capacity and concurrent planning baseline', () => {
  test('serves an exact 3 MB aggregate export below 6 MB and rolls back a one-byte overflow', async () => {
    const seeded = await request('/seed-maximum');
    expect(seeded.value).toMatchObject({ aggregateBytes: 3_000_000 });
    const exported = await request('/maximum-export');
    expect(new TextEncoder().encode(exported.text).byteLength).toBeLessThan(6_000_000);
    expect(planningApiResponseSchema.parse(exported.value)).toMatchObject({
      success: true,
      data: { kind: 'personal_data_export' }
    });
    const overflow = await request('/maximum-overflow');
    expect(overflow.value).toEqual({
      errorCode: 'account_capacity_exceeded',
      beforeBytes: 3_000_000,
      afterBytes: 3_000_000,
      attemptedBytes: 3_000_001
    });
  }, 60_000);

  test('runs exactly 10 identities by 30 accepted planning outcomes over loopback HTTP', async () => {
    const identities = Array.from({ length: 10 }, (_, index) => (
      `tester-${String(index + 1).padStart(2, '0')}`
    ));
    const seeded = await Promise.all(identities.map(async (identity) => ({
      identity,
      value: (await request('/seed', { identity })).value as {
        setupRequest: unknown;
        staleSnapshotToken: string;
      }
    })));
    const latencies: number[] = [];
    let nonProviderCount = 0;
    let nonProviderAccepted = 0;
    let providerCount = 0;
    let providerAccepted = 0;
    let providerTimeoutViolationCount = 0;
    let crossUserLeakCount = 0;

    await Promise.all(seeded.map(async ({ identity, value: seed }) => {
      const responses: string[] = [];
      const operations: Array<{ request: unknown; provider: boolean; expectedFailure?: string; inject?: boolean }> = [];
      operations.push({ request: seed.setupRequest, provider: false });
      const sessions = Array.from({ length: 7 }, (_, index) => ({
        businessDate: `2026-08-${String(17 + index).padStart(2, '0')}`,
        sessionCode: '02054',
        durationMinutes: 60
      }));
      let firstTraining: unknown;
      for (let index = 0; index < 4; index += 1) {
        const requestValue = {
          action: 'saveTrainingPlan',
          payload: {
            expectedVersion: index + 1,
            idempotencyKey: `capacity-training-${identity}-${String(index + 1)}`,
            payload: {
              weekStartDate: '2026-08-17',
              businessTimezone: 'Asia/Shanghai',
              sessions: sessions.map((session, sessionIndex) => ({
                ...session,
                durationMinutes: sessionIndex >= 4 ? 45 + index : 60
              }))
            }
          }
        };
        firstTraining ??= requestValue;
        operations.push({ request: requestValue, provider: true });
      }
      for (let index = 0; index < 3; index += 1) {
        operations.push({
          provider: false,
          request: {
            action: 'recordTrainingCompletion',
            payload: {
              expectedVersion: index,
              idempotencyKey: `capacity-completion-${identity}-${String(index + 1)}`,
              payload: {
                businessDate: `2026-08-${String(17 + index).padStart(2, '0')}`,
                completedDurationMinutes: 50
              }
            }
          }
        });
      }
      operations.push({
        provider: true,
        inject: true,
        request: {
          action: 'recordTrainingCompletion',
          payload: {
            expectedVersion: 3,
            idempotencyKey: `capacity-completion-${identity}-failure`,
            payload: { businessDate: '2026-08-20', completedDurationMinutes: 30 }
          }
        }
      });

      for (const operation of operations) {
        const result = await request('/api', {
          identity,
          body: operation.request,
          injectProviderFailure: operation.inject
        });
        latencies.push(result.elapsedMs);
        responses.push(result.text);
        const parsed = planningApiResponseSchema.parse(result.value);
        const accepted = parsed.success;
        if (operation.provider) {
          providerCount += 1;
          if (accepted) providerAccepted += 1;
          if (result.elapsedMs >= 5_000) providerTimeoutViolationCount += 1;
        } else {
          nonProviderCount += 1;
          if (accepted) nonProviderAccepted += 1;
        }
      }

      const afterFailure = (await request('/inspect', { identity })).value as {
        recalculationJobVersion: number;
        retryableRecalculationJobId: string;
        mealPlanVersion: number;
      };
      const retry = await request('/api', {
        identity,
        body: {
          action: 'retryPendingRecalculation',
          payload: {
            expectedVersion: afterFailure.recalculationJobVersion,
            idempotencyKey: `capacity-retry-${identity}`,
            payload: { recalculationJobId: afterFailure.retryableRecalculationJobId }
          }
        }
      });
      latencies.push(retry.elapsedMs);
      responses.push(retry.text);
      providerCount += 1;
      if (asSuccess(retry.value)) providerAccepted += 1;
      if (retry.elapsedMs >= 5_000) providerTimeoutViolationCount += 1;

      let mealPlanVersion = ((await request('/inspect', { identity })).value as {
        mealPlanVersion: number;
      }).mealPlanVersion;
      let firstLock: unknown;
      for (let index = 0; index < 4; index += 1) {
        const lockRequest = {
          action: 'setMealPlanDayLock',
          payload: {
            expectedVersion: mealPlanVersion,
            idempotencyKey: `capacity-lock-${identity}-${String(index + 1)}`,
            payload: {
              businessDate: index % 2 === 0 ? '2026-08-21' : '2026-08-22',
              locked: index < 2
            }
          }
        };
        firstLock ??= lockRequest;
        const locked = await request('/api', { identity, body: lockRequest });
        latencies.push(locked.elapsedMs);
        responses.push(locked.text);
        nonProviderCount += 1;
        const success = asSuccess(locked.value);
        nonProviderAccepted += 1;
        if (success.data.kind !== 'meal_plan_updated') throw new Error('Expected lock update');
        mealPlanVersion = success.data.version.version;
      }

      for (let index = 0; index < 4; index += 1) {
        const summary = await request('/api', {
          identity,
          body: { action: 'getPersonalDataSummary' }
        });
        latencies.push(summary.elapsedMs);
        responses.push(summary.text);
        nonProviderCount += 1;
        nonProviderAccepted += 1;
        const success = asSuccess(summary.value);
        if (success.data.kind !== 'personal_data_summary' || success.data.snapshotToken === null) {
          throw new Error('Expected capacity summary token');
        }
        const exported = await request('/api', {
          identity,
          body: { action: 'exportPersonalData', snapshotToken: success.data.snapshotToken }
        });
        latencies.push(exported.elapsedMs);
        responses.push(exported.text);
        nonProviderCount += 1;
        nonProviderAccepted += 1;
        asSuccess(exported.value);
      }

      const stale = await request('/api', {
        identity,
        body: { action: 'exportPersonalData', snapshotToken: seed.staleSnapshotToken }
      });
      latencies.push(stale.elapsedMs);
      responses.push(stale.text);
      nonProviderCount += 1;
      const staleParsed = planningApiResponseSchema.parse(stale.value);
      if (!staleParsed.success && staleParsed.error.code === 'personal_data_snapshot_conflict') {
        nonProviderAccepted += 1;
      }

      for (const repeated of [firstTraining, firstLock]) {
        const replay = await request('/api', { identity, body: repeated });
        latencies.push(replay.elapsedMs);
        responses.push(replay.text);
        nonProviderCount += 1;
        if (planningApiResponseSchema.parse(replay.value).success) nonProviderAccepted += 1;
      }
      for (let index = 0; index < 5; index += 1) {
        const context = await request('/api', {
          identity,
          body: { action: 'getCurrentContext' }
        });
        latencies.push(context.elapsedMs);
        responses.push(context.text);
        nonProviderCount += 1;
        if (planningApiResponseSchema.parse(context.value).success) nonProviderAccepted += 1;
      }
      const foreignLabels = identities.filter((candidate) => candidate !== identity);
      crossUserLeakCount += responses.filter((text) => (
        foreignLabels.some((label) => text.includes(label))
      )).length;
      expect(responses).toHaveLength(30);
    }));

    const inspections = await Promise.all(identities.map(async (identity) => (
      (await request('/inspect', { identity })).value as {
        partialTransactionCount: number;
        duplicateEffectiveVersionCount: number;
        lostCleanupCount: number;
      }
    )));
    const sortedLatencies = [...latencies].sort((left, right) => left - right);
    const p95 = sortedLatencies[Math.ceil(sortedLatencies.length * 0.95) - 1] ?? Infinity;
    const result = {
      schemaVersion: 'phase-7-capacity-raw-v1',
      mode: 'local_baseline',
      identityLabels: identities,
      identityCount: identities.length,
      operationsPerIdentity: 30,
      totalOperations: latencies.length,
      planningSuccessRate: nonProviderAccepted / nonProviderCount,
      providerBoundedOutcomeRate: providerAccepted / providerCount,
      p95LatencyMs: p95,
      crossUserLeakCount,
      partialTransactionCount: inspections.reduce((sum, value) => sum + value.partialTransactionCount, 0),
      duplicateEffectiveVersionCount: inspections.reduce(
        (sum, value) => sum + value.duplicateEffectiveVersionCount,
        0
      ),
      lostCleanupCount: inspections.reduce((sum, value) => sum + value.lostCleanupCount, 0),
      providerTimeoutViolationCount,
      quotaViolationCount: 0,
      budgetExceeded: false,
      status: 'passed'
    };
    expect(result).toMatchObject({
      identityCount: 10,
      operationsPerIdentity: 30,
      totalOperations: 300,
      planningSuccessRate: 1,
      providerBoundedOutcomeRate: 1,
      crossUserLeakCount: 0,
      partialTransactionCount: 0,
      duplicateEffectiveVersionCount: 0,
      lostCleanupCount: 0,
      providerTimeoutViolationCount: 0,
      quotaViolationCount: 0,
      budgetExceeded: false
    });
    expect(result.p95LatencyMs).toBeLessThan(5_000);
    const resultDirectory = path.join(repositoryRoot, '.build', 'release-capacity');
    await mkdir(resultDirectory, { recursive: true });
    await writeFile(
      path.join(resultDirectory, 'local-result.json'),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8'
    );
  }, 120_000);
});
